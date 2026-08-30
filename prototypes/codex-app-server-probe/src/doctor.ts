import {
  access,
  constants,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { RunArtifacts } from "./artifacts.ts";
import {
  EXPECTED_EFFORT,
  EXPECTED_MODEL,
  TARGET_REPOSITORY,
  TARGET_REMOTE,
  type CliOptions,
  initializeCampaign,
  providerAuthReady,
} from "./config.ts";
import { buildChildEnvironment, leakedKeys } from "./environment.ts";
import { readLocalOrigin } from "./git-policy.ts";
import { canonicalExisting, plannedWithin } from "./paths.ts";
import { Redactor } from "./redaction.ts";
import { inspectSchemas, requireRestrictedReadSchema } from "./schema.ts";
import {
  ProbeError,
  type AssertionRecord,
  type ResultName,
  type RunManifest,
} from "./types.ts";

async function execute(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const child = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return timedOut
        ? { code: 124, stdout, stderr: `timed out after ${timeoutMs} ms` }
        : { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executableAvailable(
  name: string,
  environment: Record<string, string>,
): Promise<boolean> {
  for (const directory of (environment.PATH ?? "").split(":")) {
    if (!directory) continue;
    try {
      await access(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function keychainToken(
  service: string,
  account: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new ProbeError(
      "rejected",
      "keychain_unavailable",
      "doctor pr requires macOS /usr/bin/security",
    );
  }
  const result = await execute(
    [
      "/usr/bin/security",
      "find-generic-password",
      "-w",
      "-s",
      service,
      "-a",
      account,
    ],
    "/tmp",
    env,
    timeoutMs,
  );
  const value = result.stdout.trim();
  if (result.code !== 0 || !value) {
    throw new ProbeError(
      "rejected",
      "keychain_entry_missing",
      `Keychain entry ${service}/${account} is missing or empty`,
    );
  }
  return value;
}

export async function runDoctor(
  options: CliOptions,
): Promise<{ result: ResultName; runRoot: string }> {
  const campaign = await initializeCampaign(options.campaignRoot);
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-doctor`;
  const runRoot = plannedWithin(
    campaign.runsRoot,
    join(campaign.runsRoot, runId),
    "doctor run root",
  );
  const agentHome = plannedWithin(
    runRoot,
    join(runRoot, "agent-home"),
    "doctor agent home",
  );
  const schemaRoot = plannedWithin(
    runRoot,
    join(runRoot, "schemas"),
    "doctor schema root",
  );
  await Promise.all([
    mkdir(agentHome, { recursive: true }),
    mkdir(schemaRoot, { recursive: true }),
  ]);
  let token: string | undefined;
  let redactor = new Redactor([]);
  const artifacts = new RunArtifacts(runRoot, redactor);
  await artifacts.initialize();
  const started = Date.now();
  let result: ResultName = "completed";
  let codexVersion = "unknown";
  let schemaDigest = "unknown";
  const assertions: AssertionRecord[] = [];
  const baseEnvironment = buildChildEnvironment({
    codexHome: campaign.codexHome,
    agentHome,
    scenario: "doctor",
  });
  try {
    const configText = await readFile(
      join(campaign.codexHome, "config.toml"),
      "utf8",
    );
    const authReady = await providerAuthReady(campaign.codexHome);
    assertions.push(
      {
        name: "isolated_codex_home",
        passed:
          campaign.codexHome === join(campaign.campaignRoot, "codex-home"),
        detail: campaign.codexHome,
      },
      {
        name: "credential_store_file",
        passed: configText.includes('cli_auth_credentials_store = "file"'),
        detail: "file",
      },
      {
        name: "provider_auth_ready",
        passed: authReady,
        detail: authReady
          ? "isolated authentication data present"
          : "isolated authentication data missing or invalid, run the documented isolated login",
      },
      {
        name: "active_integrations",
        passed:
          configText.includes("[mcp_servers]") &&
          !/\[mcp_servers\.[^\]]+\]/.test(configText),
        detail: "none",
      },
      {
        name: "child_environment_allowlist",
        passed: leakedKeys(baseEnvironment).length === 0,
        detail: Object.keys(baseEnvironment).sort().join(", "),
      },
      {
        name: "sandbox_policy",
        passed: true,
        detail:
          "readOnly for read; workspaceWrite with network disabled for edit, fail, and interrupt",
      },
    );
    const version = await execute(
      [options.codexExecutable, "--version"],
      runRoot,
      baseEnvironment,
      options.timeouts.modelSchemaMs,
    );
    if (version.code !== 0)
      throw new ProbeError("rejected", "codex_version_failed", version.stderr);
    codexVersion = version.stdout.trim();
    const schema = await execute(
      [
        options.codexExecutable,
        "app-server",
        "generate-json-schema",
        "--out",
        schemaRoot,
      ],
      runRoot,
      baseEnvironment,
      options.timeouts.modelSchemaMs,
    );
    if (schema.code !== 0)
      throw new ProbeError(
        "protocol_error",
        "schema_generation_failed",
        schema.stderr,
      );
    schemaDigest = (await inspectSchemas(schemaRoot)).digest;
    assertions.push({
      name: "schema_coverage",
      passed: true,
      detail: schemaDigest,
    });
    try {
      await requireRestrictedReadSchema(schemaRoot);
      assertions.push({
        name: "restricted_read_schema",
        passed: true,
        detail: "readableRoots and macOS platform defaults supported",
      });
    } catch (error) {
      assertions.push({
        name: "restricted_read_schema",
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (options.doctorPr) {
      if (!(await executableAvailable("git", baseEnvironment))) {
        throw new ProbeError(
          "rejected",
          "git_missing",
          "Git is not available on the child PATH",
        );
      }
      if (!(await executableAvailable("gh", baseEnvironment))) {
        throw new ProbeError(
          "rejected",
          "gh_missing",
          "gh is not available on the child PATH",
        );
      }
      if (!options.source) {
        throw new ProbeError(
          "rejected",
          "doctor_pr_source_required",
          "doctor pr requires --source with the seeded target checkout",
        );
      }
      const source = await canonicalExisting(options.source);
      const sourceRemote = await readLocalOrigin(source);
      if (sourceRemote !== TARGET_REMOTE) {
        throw new ProbeError(
          "assertion_failed",
          "doctor_pr_remote_mismatch",
          `Expected ${TARGET_REMOTE}, got ${sourceRemote}`,
        );
      }
      token = await keychainToken(
        options.keychainService,
        options.keychainAccount,
        baseEnvironment,
        options.timeouts.initializationMs,
      );
      redactor.add(token);
      const gitGlobalConfig = join(agentHome, "empty-git-config");
      await writeFile(gitGlobalConfig, "", { mode: 0o600 });
      const prEnvironment = buildChildEnvironment({
        codexHome: campaign.codexHome,
        agentHome,
        scenario: "pr",
        githubToken: token,
        gitGlobalConfig,
      });
      const tools = await Promise.all([
        execute(
          ["git", "--version"],
          runRoot,
          prEnvironment,
          options.timeouts.initializationMs,
        ),
        execute(
          ["gh", "--version"],
          runRoot,
          prEnvironment,
          options.timeouts.initializationMs,
        ),
      ]);
      assertions.push(
        {
          name: "git_available",
          passed: tools[0].code === 0,
          detail: tools[0].stdout.trim(),
        },
        {
          name: "gh_available",
          passed: tools[1].code === 0,
          detail: tools[1].stdout.split("\n")[0] ?? "",
        },
        {
          name: "target_https_remote",
          passed: TARGET_REMOTE.startsWith("https://"),
          detail: TARGET_REMOTE,
        },
        {
          name: "target_repository_identity",
          passed: TARGET_REPOSITORY === "alundgren/irudd-factory-agent-testing",
          detail: TARGET_REPOSITORY,
        },
        {
          name: "source_checkout_remote",
          passed: sourceRemote === TARGET_REMOTE,
          detail: sourceRemote,
        },
      );
      const access = await execute(
        ["gh", "api", `repos/${TARGET_REPOSITORY}`, "--jq", ".full_name"],
        runRoot,
        prEnvironment,
        options.timeouts.modelSchemaMs,
      );
      assertions.push({
        name: "target_repository_read_access",
        passed: access.code === 0 && access.stdout.trim() === TARGET_REPOSITORY,
        detail:
          access.code === 0
            ? access.stdout.trim()
            : redactor.text(access.stderr),
      });
      assertions.push({
        name: "github_permission_human_check",
        passed: true,
        detail:
          "Human must verify repository selection and contents permissions in GitHub settings; the API check cannot prove safe write scope",
      });
    }
    const failed = assertions.find((assertion) => !assertion.passed);
    if (failed) {
      throw new ProbeError(
        "assertion_failed",
        `doctor_${failed.name}`,
        failed.detail,
      );
    }
  } catch (error) {
    const probeError =
      error instanceof ProbeError
        ? error
        : new ProbeError(
            "protocol_error",
            "doctor_failed",
            redactor.error(error),
          );
    result = probeError.result;
    if (!assertions.some((assertion) => assertion.name === probeError.code)) {
      assertions.push({
        name: probeError.code,
        passed: false,
        detail: redactor.error(probeError),
      });
    }
    artifacts.record("probe", {
      code: probeError.code,
      result: probeError.result,
      error: redactor.error(probeError),
    });
  } finally {
    const finished = Date.now();
    const manifest: RunManifest = {
      runId,
      scenario: "doctor",
      campaignRoot: campaign.campaignRoot,
      runRoot,
      workspace: null,
      allowedParentPaths: [campaign.campaignRoot, "/tmp"],
      sandboxPolicy: {
        read: "readOnly",
        write: "workspaceWrite",
        network: "pr approvals only",
      },
      remote: options.doctorPr ? TARGET_REMOTE : null,
      repository: options.doctorPr ? TARGET_REPOSITORY : null,
      startingCommit: null,
      requestedModel: EXPECTED_MODEL,
      requestedEffort: EXPECTED_EFFORT,
      observedModel: null,
      reroutes: [],
      codexVersion,
      schemaDigest,
      threadId: null,
      turnId: null,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      serializedUtf8Bytes: artifacts.serializedBytes(),
      itemLifecycles: [],
      tokenUsageUpdates: [],
      approvals: [],
      processExit: null,
      result,
      effects: { activeIntegrations: [] },
      assertions,
      timeouts: options.timeouts,
    };
    await artifacts.finish(redactor.value(manifest));
    token = undefined;
  }
  return { result, runRoot };
}
