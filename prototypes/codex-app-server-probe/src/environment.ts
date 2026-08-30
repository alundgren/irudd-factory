import type { ScenarioName } from "./types.ts";

const SAFE_INHERITED_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
] as const;
export const FORBIDDEN_ENV_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /^AWS_/,
  /^AZURE_/,
  /^GOOGLE_/,
  /^GCP_/,
  /^GITHUB_/,
  /^GH_/,
  /^SSH_AUTH_SOCK$/,
  /^CODEX_/,
  /^CLAUDE_/,
  /^OPENAI_/,
];

export function buildChildEnvironment(options: {
  source?: Record<string, string | undefined>;
  codexHome: string;
  agentHome: string;
  scenario: ScenarioName | "doctor";
  githubToken?: string;
  gitAskpass?: string;
  gitGlobalConfig?: string;
}): Record<string, string> {
  const source = options.source ?? process.env;
  const environment: Record<string, string> = {};
  for (const key of SAFE_INHERITED_KEYS) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  environment.HOME = options.agentHome;
  environment.CODEX_HOME = options.codexHome;
  environment.NO_COLOR = "1";
  environment.CI = "1";
  if (options.scenario === "pr" && options.githubToken) {
    if (!options.gitGlobalConfig) {
      throw new Error(
        "pr child environment requires an empty global Git config",
      );
    }
    environment.GH_TOKEN = options.githubToken;
    environment.GH_PROMPT_DISABLED = "1";
    environment.GIT_TERMINAL_PROMPT = "0";
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_GLOBAL = options.gitGlobalConfig;
    if (options.gitAskpass) environment.GIT_ASKPASS = options.gitAskpass;
  }
  return environment;
}

export function buildKeychainEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_INHERITED_KEYS) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  // macOS resolves the keychain search list from the operator HOME, so this
  // parent-side lookup keeps it. The child environment never receives it.
  const home = source.HOME;
  if (!home) {
    throw new Error("Reading the Keychain requires the operator HOME");
  }
  environment.HOME = home;
  environment.NO_COLOR = "1";
  return environment;
}

export function leakedKeys(environment: Record<string, string>): string[] {
  const namedExceptions = new Set([
    "GH_TOKEN",
    "GH_PROMPT_DISABLED",
    "CODEX_HOME",
  ]);
  return Object.keys(environment).filter(
    (key) =>
      !namedExceptions.has(key) &&
      FORBIDDEN_ENV_PATTERNS.some((pattern) => pattern.test(key)),
  );
}
