import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RunArtifacts } from "./artifacts.ts";
import {
  EXPECTED_EFFORT,
  EXPECTED_MODEL,
  TARGET_REMOTE,
  TARGET_REPOSITORY,
  type CliOptions,
  initializeCampaign,
  operatorCodexHome,
  providerAuthReady,
} from "./config.ts";
import {
  buildChildEnvironment,
  buildKeychainEnvironment,
  leakedKeys,
} from "./environment.ts";
import {
  gitGlobalConfigPath,
  sanitizeCopiedGitDirectory,
} from "./git-policy.ts";
import { canonicalExisting, isWithin, plannedWithin } from "./paths.ts";
import {
  spawnManaged,
  terminateOwnedGroup,
  type ManagedProcess,
} from "./process.ts";
import { Redactor } from "./redaction.ts";
import { RpcClient } from "./rpc.ts";
import { inspectSchemas, requireScenarioSandboxSchema } from "./schema.ts";
import {
  ProbeError,
  type AssertionRecord,
  type ResultName,
  type RpcMessage,
  type RunManifest,
  type ScenarioName,
} from "./types.ts";

const PROTOTYPE_ROOT = resolve(dirname(import.meta.dir));
const FIXTURE_ROOT = join(PROTOTYPE_ROOT, "fixture");
const PROMPTS_ROOT = join(PROTOTYPE_ROOT, "prompts");

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PrBaseline {
  defaultBranch: string;
  oid: string;
}

class ExpectedScenarioEnd extends Error {}

async function command(
  argv: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env:
      options.env ??
      buildChildEnvironment({
        codexHome: options.cwd,
        agentHome: options.cwd,
        scenario: "doctor",
      }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = options.timeoutMs
    ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
    : undefined;
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readKeychainToken(
  service: string,
  account: string,
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new ProbeError(
      "rejected",
      "keychain_unavailable",
      "The pr scenario requires macOS /usr/bin/security",
    );
  }
  const result = await command(
    [
      "/usr/bin/security",
      "find-generic-password",
      "-w",
      "-s",
      service,
      "-a",
      account,
    ],
    { cwd: "/tmp", env: buildKeychainEnvironment() },
  );
  const token = result.stdout.trim();
  if (result.code !== 0 || !token) {
    throw new ProbeError(
      "rejected",
      "keychain_entry_missing",
      `No nonempty Keychain entry for service ${service}`,
    );
  }
  return token;
}

async function prepareWorkspace(
  scenario: ScenarioName,
  runRoot: string,
  source: string | null,
): Promise<string> {
  const workspace = plannedWithin(
    runRoot,
    join(runRoot, "workspace"),
    "scenario workspace",
  );
  if (scenario === "pr") {
    if (!source)
      throw new ProbeError(
        "rejected",
        "source_required",
        "pr requires --source with a seeded checkout",
      );
    const canonicalSource = await canonicalExisting(source);
    if (isWithin(runRoot, canonicalSource)) {
      throw new ProbeError(
        "rejected",
        "source_inside_run",
        "The pr source must be outside the fresh run directory",
      );
    }
    await cp(canonicalSource, workspace, {
      recursive: true,
      preserveTimestamps: true,
    });
    await sanitizeCopiedGitDirectory(workspace, TARGET_REMOTE);
  } else {
    await cp(FIXTURE_ROOT, workspace, { recursive: true });
  }
  const gitDir = join(workspace, ".git");
  if (!(await Bun.file(join(gitDir, "HEAD")).exists())) {
    await command(["git", "init", "-q", "-b", "main"], { cwd: workspace });
    await command(["git", "config", "user.name", "Codex Probe"], {
      cwd: workspace,
    });
    await command(
      ["git", "config", "user.email", "codex-probe@example.invalid"],
      { cwd: workspace },
    );
    await command(["git", "add", "."], { cwd: workspace });
    const committed = await command(
      ["git", "commit", "-q", "-m", "Seed deterministic probe fixture"],
      {
        cwd: workspace,
      },
    );
    if (committed.code !== 0) {
      throw new ProbeError(
        "assertion_failed",
        "fixture_commit_failed",
        committed.stderr,
      );
    }
  }
  return canonicalExisting(workspace);
}

async function codexVersionAndSchemas(
  executable: string,
  schemaRoot: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<{ version: string; digest: string }> {
  await mkdir(schemaRoot, { recursive: true });
  const version = await command([executable, "--version"], {
    cwd,
    env,
    timeoutMs,
  });
  if (version.code !== 0) {
    throw new ProbeError(
      "rejected",
      "codex_version_failed",
      version.stderr || "codex --version failed",
    );
  }
  const generated = await command(
    [executable, "app-server", "generate-json-schema", "--out", schemaRoot],
    { cwd, env, timeoutMs },
  );
  if (generated.code !== 0) {
    throw new ProbeError(
      "protocol_error",
      "schema_generation_failed",
      generated.stderr,
    );
  }
  const inspected = await inspectSchemas(schemaRoot);
  return { version: version.stdout.trim(), digest: inspected.digest };
}

function sandboxFor(
  scenario: ScenarioName,
  workspace: string,
): Record<string, unknown> {
  return scenario === "read"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      };
}

function modelSupportsLow(result: any): boolean {
  if (!Array.isArray(result?.data)) return false;
  const model = result.data.find(
    (entry: any) =>
      entry?.id === EXPECTED_MODEL || entry?.model === EXPECTED_MODEL,
  );
  return Boolean(
    model &&
      Array.isArray(model.supportedReasoningEfforts) &&
      model.supportedReasoningEfforts.some(
        (effort: any) =>
          effort === EXPECTED_EFFORT ||
          effort?.reasoningEffort === EXPECTED_EFFORT,
      ),
  );
}

function observedModel(message: RpcMessage): string | null {
  const params = message.params as any;
  for (const value of [
    params?.model,
    params?.threadSettings?.model,
    params?.turn?.model,
    params?.response?.model,
    params?.item?.model,
    params?.thread?.model,
  ]) {
    if (typeof value === "string") return value;
  }
  return null;
}

function observedEffort(message: RpcMessage): string | null {
  const params = message.params as any;
  for (const value of [
    params?.threadSettings?.effort,
    params?.turn?.effort,
    params?.effort,
    params?.reasoningEffort,
  ]) {
    if (typeof value === "string") return value;
  }
  return null;
}

function observedIntegrations(
  runtimeIntegrations: Map<string, string>,
): Record<string, string> {
  return Object.fromEntries([...runtimeIntegrations.entries()].sort());
}

export const ALLOWED_RUNTIME_INTEGRATIONS = ["codex_apps"] as const;

export function providerContractAssertions(
  scenario: ScenarioName,
  threadSettings: unknown,
  runtimeIntegrations: Map<string, string>,
): AssertionRecord[] {
  const observed = [...runtimeIntegrations.entries()]
    .map(([name, status]) => `${name}=${status}`)
    .sort();
  const unexpected = [...runtimeIntegrations.keys()].filter(
    (name) => !ALLOWED_RUNTIME_INTEGRATIONS.includes(name as never),
  );
  const settings = threadSettings as any;
  const policy = settings?.sandboxPolicy;
  const records: AssertionRecord[] = [
    {
      name: "runtime_integrations",
      passed: unexpected.length === 0,
      detail: observed.length
        ? `built-in only: ${observed.join(", ")}`
        : "none started",
    },
    {
      name: "thread_settings_confirmation",
      passed: scenario === "read" ? true : Boolean(settings),
      detail: settings
        ? `model ${settings.model}, effort ${settings.effort}`
        : "no thread/settings/updated event; read-only turns do not emit one",
    },
  ];
  if (policy) {
    records.push({
      name: "effective_turn_sandbox",
      passed:
        scenario === "read"
          ? policy.type === "readOnly"
          : policy.type === "workspaceWrite" &&
            policy.networkAccess === false &&
            policy.excludeSlashTmp === true &&
            policy.excludeTmpdirEnvVar === true,
      detail: `${policy.type}, network ${policy.networkAccess}, echoed writableRoots ${JSON.stringify(policy.writableRoots ?? null)}; the working directory is writable without being echoed`,
    });
  }
  return records;
}

function longCommandActive(message: RpcMessage): boolean {
  if (message.method !== "item/started") return false;
  const item = message.params?.item as any;
  return item?.type === "commandExecution" && Array.isArray(item.command)
    ? item.command.some((part: unknown) =>
        String(part).includes("probe-long-running"),
      )
    : String(item?.command ?? "").includes("probe-long-running");
}

async function gitValue(
  workspace: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await command(["git", ...args], {
    cwd: workspace,
    ...(env ? { env } : {}),
  });
  if (result.code !== 0)
    throw new ProbeError("assertion_failed", "git_check_failed", result.stderr);
  return result.stdout.trim();
}

async function assertionsFor(
  scenario: ScenarioName,
  workspace: string,
  agentMessages: string[],
  startingCommit: string,
  expectedBranch?: string,
  prEnvironment?: Record<string, string>,
  prBaseline?: PrBaseline,
): Promise<{
  assertions: AssertionRecord[];
  effects: Record<string, unknown>;
}> {
  const statusResult = await command(["git", "status", "--porcelain=v1"], {
    cwd: workspace,
    ...(prEnvironment ? { env: prEnvironment } : {}),
  });
  if (statusResult.code !== 0) {
    throw new ProbeError(
      "assertion_failed",
      "git_check_failed",
      statusResult.stderr,
    );
  }
  const status = statusResult.stdout.replace(/\n$/, "");
  if (scenario === "read" || scenario === "fail" || scenario === "interrupt") {
    const records: AssertionRecord[] = [
      {
        name: "workspace_has_no_diff",
        passed: status === "",
        detail: status || "clean",
      },
    ];
    if (scenario === "read") {
      const answer = agentMessages.at(-1)?.trim() ?? "";
      records.push({
        name: "exact_read_value",
        passed: answer === "# Codex App Server Probe Fixture",
        detail: answer || "no agent answer",
      });
    }
    return { assertions: records, effects: { status } };
  }
  if (scenario === "edit") {
    const source = await readFile(join(workspace, "src/greet.ts"), "utf8");
    const test = await readFile(join(workspace, "test/greet.test.ts"), "utf8");
    const expectedSource = (
      await readFile(join(FIXTURE_ROOT, "src/greet.ts"), "utf8")
    ).replace('return "Hello, probe!";', 'return "Hello, Codex probe!";');
    const expectedTest = (
      await readFile(join(FIXTURE_ROOT, "test/greet.test.ts"), "utf8")
    ).replace('toBe("Hello, probe!")', 'toBe("Hello, Codex probe!")');
    const testRun = await command(["bun", "test"], { cwd: workspace });
    const diff = await gitValue(workspace, [
      "diff",
      "--",
      "src/greet.ts",
      "test/greet.test.ts",
    ]);
    const changedFiles = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3))
      .sort();
    return {
      assertions: [
        {
          name: "exact_allowed_files",
          passed:
            JSON.stringify(changedFiles) ===
            JSON.stringify(["src/greet.ts", "test/greet.test.ts"]),
          detail: changedFiles.join(", ") || "none",
        },
        {
          name: "exact_greeting_change",
          passed: source === expectedSource && test === expectedTest,
          detail: "source and test inspected outside the agent",
        },
        {
          name: "fixture_tests_pass",
          passed: testRun.code === 0,
          detail: testRun.stderr || testRun.stdout,
        },
      ],
      effects: { status, diff },
    };
  }
  const remote = await gitValue(
    workspace,
    ["remote", "get-url", "origin"],
    prEnvironment,
  );
  const branch = await gitValue(
    workspace,
    ["branch", "--show-current"],
    prEnvironment,
  );
  const commit = await gitValue(
    workspace,
    ["rev-parse", "HEAD"],
    prEnvironment,
  );
  const source = await readFile(join(workspace, "src/greet.ts"), "utf8");
  const test = await readFile(join(workspace, "test/greet.test.ts"), "utf8");
  const expectedSource = (
    await readFile(join(FIXTURE_ROOT, "src/greet.ts"), "utf8")
  ).replace('return "Hello, probe!";', 'return "Hello from the PR probe!";');
  const expectedTest = (
    await readFile(join(FIXTURE_ROOT, "test/greet.test.ts"), "utf8")
  ).replace('toBe("Hello, probe!")', 'toBe("Hello from the PR probe!")');
  const testRun = await command(["bun", "test"], { cwd: workspace });
  const pr = prEnvironment
    ? await command(
        [
          "gh",
          "pr",
          "view",
          branch,
          "--repo",
          TARGET_REPOSITORY,
          "--json",
          "url,headRefName,headRefOid,baseRefName,state",
        ],
        { cwd: workspace, env: prEnvironment },
      )
    : { code: 1, stdout: "", stderr: "PR environment unavailable" };
  let prDetails: Record<string, unknown> = {};
  if (pr.code === 0) {
    try {
      prDetails = JSON.parse(pr.stdout) as Record<string, unknown>;
    } catch {
      prDetails = {};
    }
  }
  const defaultBranchResult = prEnvironment
    ? await command(
        [
          "gh",
          "repo",
          "view",
          TARGET_REPOSITORY,
          "--json",
          "defaultBranchRef",
          "--jq",
          ".defaultBranchRef.name",
        ],
        { cwd: workspace, env: prEnvironment },
      )
    : { code: 1, stdout: "", stderr: "PR environment unavailable" };
  const defaultBranch =
    defaultBranchResult.code === 0 ? defaultBranchResult.stdout.trim() : null;
  const remoteBaseResult =
    prEnvironment && defaultBranch
      ? await command(
          ["git", "ls-remote", "origin", `refs/heads/${defaultBranch}`],
          { cwd: workspace, env: prEnvironment },
        )
      : { code: 1, stdout: "", stderr: "PR environment unavailable" };
  const remoteBaseOid =
    prBaseline?.oid ??
    (remoteBaseResult.code === 0
      ? (remoteBaseResult.stdout.trim().split(/\s+/)[0] ?? null)
      : null);
  const committedFiles = await committedFilesFromBase(
    workspace,
    remoteBaseOid ?? startingCommit,
    commit,
    prEnvironment,
  );
  const remoteBranchResult = prEnvironment
    ? await command(["git", "ls-remote", "origin", `refs/heads/${branch}`], {
        cwd: workspace,
        env: prEnvironment,
      })
    : { code: 1, stdout: "", stderr: "PR environment unavailable" };
  const remoteOid =
    remoteBranchResult.code === 0
      ? (remoteBranchResult.stdout.trim().split(/\s+/)[0] ?? null)
      : null;
  const expectedPr = evaluatePrEvidence({
    branch,
    expectedBranch: expectedBranch ?? "",
    commit,
    startingCommit,
    remoteBaseOid,
    expectedDefaultBranch: prBaseline?.defaultBranch ?? defaultBranch,
    remoteOid,
    defaultBranch,
    prCode: pr.code,
    prDetails,
  });
  return {
    assertions: [
      {
        name: "target_remote",
        passed: remote === TARGET_REMOTE,
        detail: remote,
      },
      {
        name: "exact_run_branch",
        passed: branch === expectedBranch,
        detail: branch,
      },
      { name: "new_commit", passed: commit !== startingCommit, detail: commit },
      {
        name: "starting_commit_matches_remote_base",
        passed:
          remoteBaseOid === null
            ? prEnvironment === undefined
            : startingCommit === remoteBaseOid,
        detail: `start=${startingCommit}, remote=${remoteBaseOid ?? "unavailable"}`,
      },
      {
        name: "clean_after_pr",
        passed: status === "",
        detail: status || "clean",
      },
      {
        name: "exact_pr_files",
        passed:
          JSON.stringify(committedFiles) ===
          JSON.stringify(["src/greet.ts", "test/greet.test.ts"]),
        detail: committedFiles.join(", ") || "none",
      },
      {
        name: "exact_pr_change",
        passed: source === expectedSource && test === expectedTest,
        detail: "source and test inspected outside the agent",
      },
      {
        name: "pr_fixture_tests_pass",
        passed: testRun.code === 0,
        detail: testRun.stderr || testRun.stdout,
      },
      {
        name: "target_pull_request",
        passed: expectedPr,
        detail: pr.code === 0 ? JSON.stringify(prDetails) : pr.stderr,
      },
    ],
    effects: {
      remote,
      branch,
      commit,
      status,
      repository: TARGET_REPOSITORY,
      pullRequest: prDetails,
      defaultBranch,
      remoteOid,
      remoteBaseOid,
      committedFiles,
    },
  };
}

function evaluatePrEvidence(input: {
  branch: string;
  expectedBranch: string;
  commit: string;
  startingCommit: string;
  remoteBaseOid: string | null;
  expectedDefaultBranch: string | null;
  remoteOid: string | null;
  defaultBranch: string | null;
  prCode: number;
  prDetails: Record<string, unknown>;
}): boolean {
  return (
    input.branch === input.expectedBranch &&
    input.startingCommit === input.remoteBaseOid &&
    input.defaultBranch === input.expectedDefaultBranch &&
    input.prCode === 0 &&
    input.prDetails.state === "OPEN" &&
    input.prDetails.headRefName === input.branch &&
    input.prDetails.headRefOid === input.commit &&
    input.remoteOid === input.commit &&
    typeof input.prDetails.url === "string" &&
    input.prDetails.url.startsWith(
      `https://github.com/${TARGET_REPOSITORY}/pull/`,
    ) &&
    typeof input.defaultBranch === "string" &&
    input.defaultBranch.length > 0 &&
    input.prDetails.baseRefName === input.defaultBranch
  );
}

async function readPrBaseline(
  workspace: string,
  environment: Record<string, string>,
): Promise<PrBaseline> {
  const defaultBranchResult = await command(
    [
      "gh",
      "repo",
      "view",
      TARGET_REPOSITORY,
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ],
    { cwd: workspace, env: environment },
  );
  const defaultBranch = defaultBranchResult.stdout.trim();
  if (defaultBranchResult.code !== 0 || !defaultBranch) {
    throw new ProbeError(
      "assertion_failed",
      "remote_default_branch_unavailable",
      defaultBranchResult.stderr || "Target repository has no default branch",
    );
  }
  const oidResult = await command(
    ["git", "ls-remote", "origin", `refs/heads/${defaultBranch}`],
    { cwd: workspace, env: environment },
  );
  const oid = oidResult.stdout.trim().split(/\s+/)[0] ?? "";
  if (oidResult.code !== 0 || !oid) {
    throw new ProbeError(
      "assertion_failed",
      "remote_base_commit_unavailable",
      oidResult.stderr || `No remote commit for ${defaultBranch}`,
    );
  }
  return { defaultBranch, oid };
}

async function committedFilesFromBase(
  workspace: string,
  baseOid: string,
  commit: string,
  environment?: Record<string, string>,
): Promise<string[]> {
  return (
    await gitValue(
      workspace,
      ["diff", "--name-only", `${baseOid}..${commit}`],
      environment,
    )
  )
    .split("\n")
    .filter(Boolean)
    .sort();
}

export async function runScenario(
  options: CliOptions,
): Promise<{ result: ResultName; runRoot: string }> {
  if (options.command === "doctor")
    throw new Error("runScenario called for doctor");
  const scenario = options.command;
  const campaign = await initializeCampaign(
    options.campaignRoot,
    operatorCodexHome(),
  );
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${scenario}`;
  const runRoot = plannedWithin(
    campaign.runsRoot,
    join(campaign.runsRoot, runId),
    "run root",
  );
  await mkdir(runRoot, { recursive: false });
  let token: string | undefined;
  const redactor = new Redactor([]);
  const artifacts = new RunArtifacts(runRoot, redactor);
  await artifacts.initialize();
  const started = Date.now();
  let child: ManagedProcess | null = null;
  let client: RpcClient | null = null;
  let sigintHandler: (() => void) | null = null;
  let result: ResultName = "protocol_error";
  let workspace: string | null = null;
  let startingCommit: string | null = null;
  let remote: string | null = null;
  let codexVersion = "unknown";
  let schemaDigest = "unknown";
  let threadId: string | null = null;
  let turnId: string | null = null;
  let finalObservedModel: string | null = null;
  let finalObservedEffort: string | null = null;
  let threadSettings: unknown = null;
  const runtimeIntegrations = new Map<string, string>();
  const reroutes: unknown[] = [];
  const itemLifecycles: unknown[] = [];
  const tokenUsageUpdates: unknown[] = [];
  const agentMessages: string[] = [];
  let rejectReroute: ((error: ProbeError) => void) | null = null;
  let assertions: AssertionRecord[] = [];
  let effects: Record<string, unknown> = {};
  let processExit: { code: number | null; signal: string | null } | null = null;
  let sandboxPolicy: unknown = null;
  let prBaseline: PrBaseline | undefined;
  try {
    if (!(await providerAuthReady(campaign.codexHome))) {
      throw new ProbeError(
        "rejected",
        "provider_auth_not_ready",
        "No usable Codex credentials were found; run `codex login` normally, then rerun doctor",
      );
    }
    if (scenario === "pr") {
      token = await readKeychainToken(
        options.keychainService,
        options.keychainAccount,
      );
      redactor.add(token);
    }
    workspace = await prepareWorkspace(scenario, runRoot, options.source);
    const agentHome = plannedWithin(
      runRoot,
      join(runRoot, "agent-home"),
      "agent home",
    );
    await mkdir(agentHome, { recursive: true, mode: 0o700 });
    const gitAskpass =
      scenario === "pr"
        ? plannedWithin(
            workspace,
            join(workspace, ".git", "probe-askpass"),
            "Git askpass",
          )
        : null;
    if (gitAskpass) {
      await writeFile(
        gitAskpass,
        [
          "#!/bin/sh",
          'case "$1" in',
          '  *Username*) printf "%s\\n" "x-access-token" ;;',
          '  *Password*) printf "%s\\n" "$GH_TOKEN" ;;',
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
    }
    const env = buildChildEnvironment({
      codexHome: campaign.codexHome,
      agentHome,
      scenario,
      ...(token ? { githubToken: token } : {}),
      ...(gitAskpass ? { gitAskpass } : {}),
      ...(scenario === "pr"
        ? { gitGlobalConfig: gitGlobalConfigPath(workspace) }
        : {}),
    });
    const leaks = leakedKeys(env);
    if (leaks.length > 0) {
      throw new ProbeError(
        "assertion_failed",
        "environment_leak",
        `Forbidden child keys: ${leaks.join(", ")}`,
      );
    }
    const schemas = plannedWithin(
      runRoot,
      join(runRoot, "schemas"),
      "schema root",
    );
    const inspected = await codexVersionAndSchemas(
      options.codexExecutable,
      schemas,
      env,
      workspace,
      options.timeouts.modelSchemaMs,
    );
    codexVersion = inspected.version;
    schemaDigest = inspected.digest;
    await requireScenarioSandboxSchema(schemas);
    startingCommit = await gitValue(workspace, ["rev-parse", "HEAD"], env);
    const remoteResult = await command(["git", "remote", "get-url", "origin"], {
      cwd: workspace,
      env,
    });
    remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : null;
    if (scenario === "pr" && remote !== TARGET_REMOTE) {
      throw new ProbeError(
        "assertion_failed",
        "target_remote_mismatch",
        `Expected ${TARGET_REMOTE}, got ${remote ?? "none"}`,
      );
    }
    if (scenario === "pr") {
      prBaseline = await readPrBaseline(workspace, env);
      if (startingCommit !== prBaseline.oid) {
        throw new ProbeError(
          "assertion_failed",
          "starting_commit_not_remote_base",
          `Seeded checkout starts at ${startingCommit}, but ${prBaseline.defaultBranch} is ${prBaseline.oid}`,
        );
      }
    }
    const branch = scenario === "pr" ? `codex-probe/${runId}` : null;
    if (branch) {
      const checkout = await command(["git", "checkout", "-q", "-b", branch], {
        cwd: workspace,
        env,
      });
      if (checkout.code !== 0)
        throw new ProbeError(
          "assertion_failed",
          "branch_create_failed",
          checkout.stderr,
        );
    }
    sandboxPolicy = sandboxFor(scenario, workspace);
    child = spawnManaged({
      command: [
        options.codexExecutable,
        "app-server",
        "--stdio",
        "--strict-config",
      ],
      cwd: workspace,
      env,
    });
    client = new RpcClient(
      child,
      artifacts,
      scenario,
      options.timeouts.approvalMs,
      process.stdin,
      process.stderr,
      {
        workspace,
        readableRoots: [workspace],
        writableRoots: scenario === "read" ? [] : [workspace],
      },
    );
    client.start();
    sigintHandler = () => {
      client?.stop(
        new ProbeError(
          "approval_cancelled",
          "operator_interrupted",
          "Operator interrupted the probe",
        ),
      );
    };
    process.once("SIGINT", sigintHandler);
    const unsubscribe = client.onMessage((message) => {
      const observed = observedModel(message);
      if (observed) finalObservedModel = observed;
      const effort = observedEffort(message);
      if (effort) finalObservedEffort = effort;
      if (message.method === "thread/settings/updated")
        threadSettings = (message.params as any)?.threadSettings ?? null;
      if (message.method === "mcpServer/startupStatus/updated") {
        const params = message.params as any;
        if (typeof params?.name === "string")
          runtimeIntegrations.set(params.name, String(params.status ?? ""));
      }
      if (message.method === "model/rerouted") {
        reroutes.push(message.params ?? {});
        rejectReroute?.(
          new ProbeError(
            "model_rerouted",
            "model_rerouted",
            "App Server emitted model/rerouted",
            message.params,
          ),
        );
      }
      if (
        message.method === "item/started" ||
        message.method === "item/completed"
      ) {
        itemLifecycles.push({ method: message.method, params: message.params });
      }
      if (message.method === "thread/tokenUsage/updated")
        tokenUsageUpdates.push(message.params ?? {});
      if (message.method === "item/completed") {
        const item = message.params?.item as any;
        if (item?.type === "agentMessage" && typeof item.text === "string")
          agentMessages.push(item.text);
      }
    });
    await client.request(
      "initialize",
      {
        clientInfo: {
          name: "irudd_codex_app_server_probe",
          title: "Irudd Codex App Server Probe",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
      options.timeouts.childStartupMs,
    );
    client.notify("initialized", {});
    let models: any;
    try {
      models = await client.request(
        "model/list",
        { limit: 100, includeHidden: true },
        options.timeouts.modelSchemaMs,
      );
    } catch (error) {
      if (error instanceof ProbeError && error.code === "rpc_error") {
        throw new ProbeError(
          "model_unavailable",
          "model_list_rejected",
          `App Server rejected model/list: ${error.message}`,
          error.detail,
        );
      }
      throw error;
    }
    if (!modelSupportsLow(models)) {
      throw new ProbeError(
        "model_unavailable",
        "model_or_effort_unavailable",
        `${EXPECTED_MODEL} with ${EXPECTED_EFFORT} effort is unavailable`,
      );
    }
    const thread = await client.request(
      "thread/start",
      {
        model: EXPECTED_MODEL,
        cwd: workspace,
        approvalPolicy: "on-request",
        sandbox: scenario === "read" ? "read-only" : "workspace-write",
        serviceName: "irudd_codex_app_server_probe",
      },
      options.timeouts.initializationMs,
    );
    threadId = thread?.thread?.id ?? null;
    if (!threadId)
      throw new ProbeError(
        "protocol_error",
        "thread_id_missing",
        "thread/start returned no thread id",
      );
    finalObservedModel =
      thread?.model ?? thread?.thread?.model ?? finalObservedModel;
    finalObservedEffort = thread?.reasoningEffort ?? finalObservedEffort;
    const prompt = await readFile(join(PROMPTS_ROOT, `${scenario}.md`), "utf8");
    const rerouteFailure = new Promise<RpcMessage>((_, reject) => {
      rejectReroute = reject;
    });
    const completion = client.waitFor(
      (message) => message.method === "turn/completed",
      options.timeouts.turnMs,
      "turn_completion_timeout",
    );
    void completion.catch(() => undefined);
    const active =
      scenario === "fail" || scenario === "interrupt"
        ? client.waitFor(
            longCommandActive,
            options.timeouts.activeEventMs,
            "active_command_timeout",
          )
        : null;
    const turn = await client.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: workspace,
        approvalPolicy: "on-request",
        sandboxPolicy,
        model: EXPECTED_MODEL,
        effort: EXPECTED_EFFORT,
      },
      options.timeouts.initializationMs,
    );
    turnId = turn?.turn?.id ?? null;
    if (!turnId)
      throw new ProbeError(
        "protocol_error",
        "turn_id_missing",
        "turn/start returned no turn id",
      );
    if (active) await Promise.race([active, rerouteFailure]);
    if (scenario === "fail") {
      void completion.catch(() => undefined);
      processExit = await terminateOwnedGroup(
        child,
        options.timeouts.shutdownMs,
      );
      const checked = await assertionsFor(
        scenario,
        workspace,
        agentMessages,
        startingCommit,
      );
      assertions = [
        ...checked.assertions,
        ...providerContractAssertions(
          scenario,
          threadSettings,
          runtimeIntegrations,
        ),
      ];
      effects = {
        ...checked.effects,
        runtimeIntegrations: observedIntegrations(runtimeIntegrations),
      };
      result = assertions.some((assertion) => !assertion.passed)
        ? "assertion_failed"
        : "provider_exited";
      unsubscribe();
      throw new ExpectedScenarioEnd();
    }
    if (scenario === "interrupt") {
      await client.request(
        "turn/interrupt",
        { threadId, turnId },
        options.timeouts.initializationMs,
      );
    }
    const completed = await Promise.race([completion, rerouteFailure]);
    rejectReroute = null;
    const status = String((completed.params?.turn as any)?.status ?? "unknown");
    finalObservedModel = observedModel(completed) ?? finalObservedModel;
    finalObservedEffort = observedEffort(completed) ?? finalObservedEffort;
    if (reroutes.length > 0)
      throw new ProbeError(
        "model_rerouted",
        "model_rerouted",
        "App Server emitted model/rerouted",
      );
    if (finalObservedModel !== EXPECTED_MODEL) {
      throw new ProbeError(
        "assertion_failed",
        "observed_model_mismatch",
        `Expected observed model ${EXPECTED_MODEL}, got ${finalObservedModel ?? "none"}`,
      );
    }
    if (finalObservedEffort !== EXPECTED_EFFORT) {
      throw new ProbeError(
        "assertion_failed",
        "observed_effort_mismatch",
        `Expected observed effort ${EXPECTED_EFFORT}, got ${finalObservedEffort ?? "none"}`,
      );
    }
    const settings = threadSettings as any;
    if (settings && settings.model !== EXPECTED_MODEL) {
      throw new ProbeError(
        "assertion_failed",
        "thread_settings_model_mismatch",
        `thread/settings/updated reported model ${settings.model ?? "none"}`,
      );
    }
    if (settings && settings.effort && settings.effort !== EXPECTED_EFFORT) {
      throw new ProbeError(
        "assertion_failed",
        "thread_settings_effort_mismatch",
        `thread/settings/updated reported effort ${settings.effort}`,
      );
    }
    if (scenario === "interrupt") {
      if (status !== "interrupted") {
        throw new ProbeError(
          "assertion_failed",
          "interrupt_status_mismatch",
          `Expected interrupted, got ${status}`,
        );
      }
      result = "interrupted";
    } else if (status !== "completed") {
      throw new ProbeError(
        "protocol_error",
        "turn_not_completed",
        `Turn finished with ${status}`,
      );
    } else {
      result = "completed";
    }
    const checked = await assertionsFor(
      scenario,
      workspace,
      agentMessages,
      startingCommit,
      branch ?? undefined,
      env,
      prBaseline,
    );
    assertions = [
      ...checked.assertions,
      ...providerContractAssertions(
        scenario,
        threadSettings,
        runtimeIntegrations,
      ),
    ];
    effects = {
      ...checked.effects,
      runtimeIntegrations: observedIntegrations(runtimeIntegrations),
    };
    if (assertions.some((assertion) => !assertion.passed))
      result = "assertion_failed";
    unsubscribe();
  } catch (error) {
    if (error instanceof ExpectedScenarioEnd) {
      // The expected nonzero scenario result and its assertions are complete.
    } else {
      const probeError =
        error instanceof ProbeError
          ? error
          : new ProbeError(
              "protocol_error",
              "unexpected_error",
              redactor.error(error),
            );
      result = probeError.result;
      artifacts.record("probe", {
        result: probeError.result,
        code: probeError.code,
        error: redactor.error(probeError),
      });
      assertions.push({
        name: probeError.code,
        passed: false,
        detail: redactor.error(probeError),
      });
    }
  } finally {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    client?.stop();
    if (child) {
      try {
        const termination = await terminateOwnedGroup(
          child,
          options.timeouts.shutdownMs,
        );
        processExit ??= termination;
      } catch (error) {
        const cleanupError =
          error instanceof ProbeError
            ? error
            : new ProbeError(
                "timed_out",
                "cleanup_timeout",
                redactor.error(error),
              );
        processExit ??= { code: null, signal: "SIGKILL_TIMEOUT" };
        assertions.push({
          name: cleanupError.code,
          passed: false,
          detail: redactor.error(cleanupError),
        });
        if (result === "completed" || result === "interrupted") {
          result = "timed_out";
        }
      }
    }
    const finished = Date.now();
    const manifest: RunManifest = {
      runId,
      scenario,
      campaignRoot: campaign.campaignRoot,
      runRoot,
      workspace,
      probeManagedPaths: [campaign.campaignRoot, "/tmp"],
      sandboxPolicy,
      remote,
      repository: remote === TARGET_REMOTE ? TARGET_REPOSITORY : null,
      startingCommit,
      requestedModel: EXPECTED_MODEL,
      requestedEffort: EXPECTED_EFFORT,
      observedModel: finalObservedModel,
      observedEffort: finalObservedEffort,
      threadSettings,
      reroutes,
      codexVersion,
      schemaDigest,
      threadId,
      turnId,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      serializedUtf8Bytes: artifacts.serializedBytes(),
      itemLifecycles,
      tokenUsageUpdates,
      approvals: client?.approvals ?? [],
      processExit,
      result,
      effects,
      assertions,
      timeouts: options.timeouts,
    };
    await artifacts.finish(manifest);
    token = undefined;
  }
  return { result, runRoot };
}

export const scenarioInternals = {
  modelSupportsLow,
  sandboxFor,
  longCommandActive,
  providerContractAssertions,
  assertionsFor,
  codexVersionAndSchemas,
  evaluatePrEvidence,
  committedFilesFromBase,
};
