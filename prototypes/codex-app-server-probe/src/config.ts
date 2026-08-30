import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { plannedWithin } from "./paths.ts";
import {
  ProbeError,
  type ScenarioName,
  type Timeouts,
  DEFAULT_TIMEOUTS,
} from "./types.ts";

export const EXPECTED_MODEL = "gpt-5.6-luna" as const;
export const EXPECTED_EFFORT = "low" as const;
export const TARGET_REPOSITORY = "alundgren/irudd-factory-agent-testing";
export const TARGET_REMOTE = `https://github.com/${TARGET_REPOSITORY}.git`;

export interface CliOptions {
  command: "doctor" | ScenarioName;
  doctorPr: boolean;
  campaignRoot: string;
  codexExecutable: string;
  source: string | null;
  keychainService: string;
  keychainAccount: string;
  timeouts: Timeouts;
}

export function parseArgs(argv: string[], cwd: string): CliOptions {
  const command = argv[0];
  if (
    !command ||
    !["doctor", "read", "edit", "pr", "fail", "interrupt"].includes(command)
  ) {
    throw new ProbeError(
      "rejected",
      "usage",
      "Usage: probe <doctor [pr]|read|edit|pr|fail|interrupt> --campaign <absolute-path>",
    );
  }
  const values = new Map<string, string>();
  const allowedOptions = new Set([
    "campaign",
    "codex",
    "source",
    "keychain-service",
    "keychain-account",
    ...Object.keys(DEFAULT_TIMEOUTS),
  ]);
  let doctorPr = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (command === "doctor" && value === "pr") {
      doctorPr = true;
      continue;
    }
    if (!value?.startsWith("--")) {
      throw new ProbeError(
        "rejected",
        "unknown_argument",
        `Unknown argument: ${value ?? ""}`,
      );
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new ProbeError(
        "rejected",
        "missing_argument_value",
        `Missing value for ${value}`,
      );
    }
    const option = value.slice(2);
    if (!allowedOptions.has(option)) {
      throw new ProbeError(
        "rejected",
        "unknown_option",
        `Unknown option: ${value}`,
      );
    }
    values.set(option, next);
    index += 1;
  }
  const campaign = values.get("campaign");
  if (!campaign) {
    throw new ProbeError(
      "rejected",
      "campaign_required",
      "--campaign is required",
    );
  }
  if (!campaign.startsWith("/")) {
    throw new ProbeError(
      "rejected",
      "campaign_not_absolute",
      "--campaign must be absolute",
    );
  }
  const timeouts = { ...DEFAULT_TIMEOUTS };
  for (const key of Object.keys(timeouts) as Array<keyof Timeouts>) {
    const raw = values.get(key);
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ProbeError(
        "rejected",
        "invalid_timeout",
        `${key} must be a positive integer`,
      );
    }
    timeouts[key] = parsed;
  }
  return {
    command: command as CliOptions["command"],
    doctorPr,
    campaignRoot: resolve(campaign),
    codexExecutable: values.get("codex") ?? "codex",
    source: values.get("source") ? resolve(values.get("source")!) : null,
    keychainService:
      values.get("keychain-service") ?? "irudd-factory-agent-testing",
    keychainAccount: values.get("keychain-account") ?? "codex-probe",
    timeouts,
  };
}

export function operatorCodexHome(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = environment.CODEX_HOME;
  if (explicit && explicit.startsWith("/")) return resolve(explicit);
  const home = environment.HOME;
  return home && home.startsWith("/") ? join(resolve(home), ".codex") : null;
}

export async function initializeCampaign(
  campaignRoot: string,
  seedAuthFrom: string | null = null,
): Promise<{
  campaignRoot: string;
  codexHome: string;
  runsRoot: string;
}> {
  const root = resolve(campaignRoot);
  const codexHome = plannedWithin(root, join(root, "codex-home"), "Codex home");
  const runsRoot = plannedWithin(root, join(root, "runs"), "runs root");
  await Promise.all([
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
    mkdir(runsRoot, { recursive: true }),
  ]);
  const config = [
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "low"',
    'cli_auth_credentials_store = "file"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "[analytics]",
    "enabled = false",
    "[mcp_servers]",
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), config, { mode: 0o600 });
  if (seedAuthFrom) {
    await seedOperatorCredentials(seedAuthFrom, codexHome);
  }
  if (basename(codexHome) !== "codex-home") {
    throw new ProbeError(
      "assertion_failed",
      "invalid_codex_home",
      `Unexpected Codex home: ${codexHome}`,
    );
  }
  return { campaignRoot: root, codexHome, runsRoot };
}

export async function seedOperatorCredentials(
  operatorHome: string,
  codexHome: string,
): Promise<"reused" | "copied" | "operator_credentials_missing"> {
  if (await providerAuthReady(codexHome)) return "reused";
  const source = join(operatorHome, "auth.json");
  if (!(await Bun.file(source).exists())) return "operator_credentials_missing";
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  return (await providerAuthReady(codexHome))
    ? "copied"
    : "operator_credentials_missing";
}

export async function providerAuthReady(codexHome: string): Promise<boolean> {
  const authFile = Bun.file(join(codexHome, "auth.json"));
  if (!(await authFile.exists())) return false;
  try {
    const auth = (await authFile.json()) as Record<string, any>;
    return [
      auth.OPENAI_API_KEY,
      auth.api_key,
      auth.tokens?.access_token,
      auth.tokens?.id_token,
      auth.tokens?.refresh_token,
    ].some((value) => typeof value === "string" && value.length > 0);
  } catch {
    return false;
  }
}
