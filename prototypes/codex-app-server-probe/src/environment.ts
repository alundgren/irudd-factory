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
  operatorHome?: string;
}): Record<string, string> {
  const source = options.source ?? process.env;
  const environment: Record<string, string> = {};
  for (const key of SAFE_INHERITED_KEYS) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  // The pr scenario uses the ambient gh and git credentials of the operator,
  // which macOS keeps in the login keychain and gh keyring. Both are reached
  // through the operator HOME, so pr runs with it and every other scenario
  // keeps the empty run-local home.
  environment.HOME =
    options.scenario === "pr" && options.operatorHome
      ? options.operatorHome
      : options.agentHome;
  environment.CODEX_HOME = options.codexHome;
  environment.NO_COLOR = "1";
  environment.CI = "1";
  if (options.scenario === "pr") {
    if (!options.operatorHome) {
      throw new Error("The pr scenario requires the operator HOME");
    }
    environment.GH_PROMPT_DISABLED = "1";
    environment.GIT_TERMINAL_PROMPT = "0";
  }
  return environment;
}

export function leakedKeys(environment: Record<string, string>): string[] {
  const namedExceptions = new Set(["GH_PROMPT_DISABLED", "CODEX_HOME"]);
  return Object.keys(environment).filter(
    (key) =>
      !namedExceptions.has(key) &&
      FORBIDDEN_ENV_PATTERNS.some((pattern) => pattern.test(key)),
  );
}
