import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AUTHOR_WRITE_PERMISSIONS,
  CLAIM_LABEL,
  FactoryError,
  type GitHubService,
  parseWorkflow,
  type WorkflowPolicy,
  REPOSITORY_NAME_PATTERN,
  REQUIRED_ISSUE_LABELS,
  WORKFLOW_FILE,
} from "@irudd-factory/application";
import {
  ASSIGNMENT_EVENTS,
  type CommandReceipt,
  type FactorySnapshot,
  RPC_PATH,
} from "@irudd-factory/contracts";
import {
  makeGitHubService,
  nodeCommandRunner,
  type CommandRunner,
} from "@irudd-factory/github";
import { githubHttpsRemote } from "@irudd-factory/workspaces";
import { Effect, Schema } from "effect";
import { getFactorySnapshot, runNextEligibleIssue } from "@irudd-factory/cli";
import {
  CONFIG_FILE_NAME,
  CONFIG_FLAG,
  loadIntegrationConfig,
  type IntegrationConfig,
} from "./config.ts";
import {
  productionDependencies,
  startFactoryService,
  type FactoryDependencies,
} from "./service.ts";

export const DEFAULT_INTEGRATION_REPOSITORY =
  "alundgren/irudd-factory-agent-testing";
export const INTEGRATION_ROOT = join(".factory", "integration");
const REPOSITORY_FLAG = "--repository";
const writePermissions = new Set<string>(AUTHOR_WRITE_PERMISSIONS);
const TERMINAL_STATES = new Set(["completed", "failed"]);
const EXPECTED_EVENTS = [
  ASSIGNMENT_EVENTS.reserved,
  ASSIGNMENT_EVENTS.providerStartRequested,
  ASSIGNMENT_EVENTS.workspaceCreated,
  ASSIGNMENT_EVENTS.providerThreadStarted,
  ASSIGNMENT_EVENTS.providerTurnStarted,
  ASSIGNMENT_EVENTS.providerTurnFinished,
  ASSIGNMENT_EVENTS.completed,
] as const;

const UserResponse = Schema.Struct({ login: Schema.String });
const PermissionResponse = Schema.Struct({ permission: Schema.String });
const RepositoryResponse = Schema.Struct({ default_branch: Schema.String });
const WorkflowResponse = Schema.Struct({
  sha: Schema.String,
  encoding: Schema.Literal("base64"),
  content: Schema.String,
});
const LabelResponse = Schema.Struct({ name: Schema.String });
const CreatedIssueResponse = Schema.Struct({
  node_id: Schema.String,
  number: Schema.Number,
  html_url: Schema.String,
});

export interface IntegrationArguments {
  readonly configPath: string;
  readonly repository: string;
}

export interface CreatedIntegrationIssue {
  readonly nodeId: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

export interface IntegrationPreflight {
  readonly repository: string;
  readonly login: string;
  readonly workflow: ReturnType<typeof parseWorkflow>;
}

export interface IntegrationService {
  readonly url: string;
  readonly terminated: Promise<void>;
  readonly stop: () => Promise<void>;
}

export interface SignalSource {
  readonly on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  readonly off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
}

export interface SignalWaiter {
  readonly signal: Promise<NodeJS.Signals>;
  readonly dispose: () => void;
}

export interface IntegrationRuntime {
  readonly runner?: CommandRunner;
  readonly github?: GitHubService;
  readonly workingDirectory?: string;
  readonly loadConfig?: (path: string) => Promise<IntegrationConfig>;
  readonly startService?: (
    config: Parameters<typeof startFactoryService>[0],
    dependencies: FactoryDependencies,
  ) => Promise<IntegrationService>;
  readonly dependencies?: (
    config: Parameters<typeof startFactoryService>[0],
    github: GitHubService,
  ) => FactoryDependencies;
  readonly runNext?: typeof runNextEligibleIssue;
  readonly getSnapshot?: typeof getFactorySnapshot;
  readonly waitForSignal?: Promise<NodeJS.Signals>;
  readonly signalSource?: SignalSource;
  readonly pollIntervalMs?: number;
  readonly write?: (message: string) => void;
  readonly now?: () => Date;
  readonly id?: () => string;
}

function decode<A, I>(schema: Schema.Schema<A, I>, source: string): A {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(source) as unknown);
  } catch (error) {
    throw new FactoryError({
      code: "integration_preflight_failed",
      message: "A preflight command returned an invalid response",
      detail: String(error),
    });
  }
}

async function checked(
  runner: CommandRunner,
  args: ReadonlyArray<string>,
  input?: string,
): Promise<string> {
  let result;
  try {
    result = await runner.run(args, input);
  } catch (error) {
    throw new FactoryError({
      code: "integration_preflight_failed",
      message: `Could not run ${args[0] ?? "integration command"}`,
      detail: String(error),
    });
  }
  if (result.exitCode !== 0) {
    throw new FactoryError({
      code: "integration_preflight_failed",
      message: `${args[0] ?? "Integration command"} failed with exit code ${result.exitCode}`,
      detail: result.stderr.trim().slice(0, 4_000),
    });
  }
  return result.stdout;
}

export function normalizeGitHubRepository(source: string): string {
  if (REPOSITORY_NAME_PATTERN.test(source)) return source;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new FactoryError({
      code: "repository_invalid",
      message: `Invalid GitHub repository: ${source}`,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new FactoryError({
      code: "repository_invalid",
      message: `Invalid GitHub repository URL: ${source}`,
    });
  }
  const parts = url.pathname
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const repository = parts.join("/");
  if (parts.length !== 2 || !REPOSITORY_NAME_PATTERN.test(repository)) {
    throw new FactoryError({
      code: "repository_invalid",
      message: `Invalid GitHub repository URL: ${source}`,
    });
  }
  return repository;
}

export function integrationArgumentsFromArgs(
  args: ReadonlyArray<string>,
  workingDirectory = process.cwd(),
): IntegrationArguments {
  let configPath = resolve(workingDirectory, CONFIG_FILE_NAME);
  let repository = DEFAULT_INTEGRATION_REPOSITORY;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !value ||
      (flag !== CONFIG_FLAG && flag !== REPOSITORY_FLAG) ||
      seen.has(flag)
    ) {
      throw new FactoryError({
        code: "integration_arguments_invalid",
        message:
          "usage: test:integration [--config path] [--repository URL-or-owner/name]",
      });
    }
    seen.add(flag);
    if (flag === CONFIG_FLAG) configPath = resolve(workingDirectory, value);
    if (flag === REPOSITORY_FLAG) repository = normalizeGitHubRepository(value);
  }
  return { configPath, repository };
}

export async function preflightIntegration(
  repository: string,
  runner: CommandRunner = nodeCommandRunner,
): Promise<IntegrationPreflight> {
  for (const executable of ["git", "gh", "codex"] as const) {
    await checked(runner, [executable, "--version"]);
  }
  const user = decode(
    UserResponse,
    await checked(runner, ["gh", "api", "user"]),
  );
  if (!user.login.trim()) {
    throw new FactoryError({
      code: "integration_preflight_failed",
      message: "GitHub returned an empty ambient user login",
    });
  }
  const permission = decode(
    PermissionResponse,
    await checked(runner, [
      "gh",
      "api",
      `repos/${repository}/collaborators/${user.login}/permission`,
    ]),
  ).permission.toLowerCase();
  if (!writePermissions.has(permission)) {
    throw new FactoryError({
      code: "integration_preflight_failed",
      message: `${user.login} needs write, maintain, or admin permission in ${repository}`,
    });
  }
  const repositoryPayload = decode(
    RepositoryResponse,
    await checked(runner, ["gh", "api", `repos/${repository}`]),
  );
  const workflowPayload = decode(
    WorkflowResponse,
    await checked(runner, [
      "gh",
      "api",
      "--method",
      "GET",
      `repos/${repository}/contents/${WORKFLOW_FILE}`,
      "-f",
      `ref=${repositoryPayload.default_branch}`,
    ]),
  );
  const workflow = parseWorkflow(
    Buffer.from(
      workflowPayload.content.replaceAll("\n", ""),
      "base64",
    ).toString("utf8"),
  );
  validateIntegrationIssueLabels(workflow.policy);
  for (const label of [...REQUIRED_ISSUE_LABELS, CLAIM_LABEL]) {
    const response = decode(
      LabelResponse,
      await checked(runner, [
        "gh",
        "api",
        `repos/${repository}/labels/${encodeURIComponent(label)}`,
      ]),
    );
    if (response.name !== label) {
      throw new FactoryError({
        code: "integration_preflight_failed",
        message: `GitHub returned the wrong label for ${label}`,
      });
    }
  }
  await checked(runner, [
    "git",
    "ls-remote",
    "--exit-code",
    githubHttpsRemote(repository),
    "HEAD",
  ]);
  return { repository, login: user.login, workflow };
}

export function validateIntegrationIssueLabels(
  policy: WorkflowPolicy,
  issueLabels: ReadonlyArray<string> = REQUIRED_ISSUE_LABELS,
): void {
  const labels = new Set<string>(issueLabels);
  if (
    policy.requiredLabels.some((label) => !labels.has(label)) ||
    policy.forbiddenLabels.some((label) => labels.has(label))
  ) {
    throw new FactoryError({
      code: "integration_preflight_failed",
      message:
        "The integration issue labels are not eligible under WORKFLOW.md",
    });
  }
}

export async function createIntegrationIssue(
  preflight: IntegrationPreflight,
  runId: string,
  runner: CommandRunner = nodeCommandRunner,
): Promise<CreatedIntegrationIssue> {
  const title = `Factory integration ${runId}`;
  const marker = `factory-integration-${runId}.md`;
  const body = [
    `Add a Markdown file named \`${marker}\` at the repository root.`,
    `Include the run ID \`${runId}\` in the file.`,
    `Run \`${preflight.workflow.policy.test}\`.`,
    "Open a pull request that closes this issue.",
  ].join("\n\n");
  let result;
  try {
    result = await runner.run(
      [
        "gh",
        "api",
        "--method",
        "POST",
        `repos/${preflight.repository}/issues`,
        "--input",
        "-",
      ],
      JSON.stringify({ title, body, labels: [...REQUIRED_ISSUE_LABELS] }),
    );
  } catch (error) {
    throw new FactoryError({
      code: "integration_issue_create_failed",
      message: "Could not create the integration issue",
      detail: String(error),
    });
  }
  if (result.exitCode !== 0) {
    throw new FactoryError({
      code: "integration_issue_create_failed",
      message: `GitHub issue creation failed with exit code ${result.exitCode}`,
      detail: result.stderr.trim().slice(0, 4_000),
    });
  }
  let issue: typeof CreatedIssueResponse.Type;
  try {
    issue = Schema.decodeUnknownSync(CreatedIssueResponse)(
      JSON.parse(result.stdout) as unknown,
    );
  } catch (error) {
    throw new FactoryError({
      code: "integration_issue_create_failed",
      message: "GitHub returned an invalid created issue",
      detail: String(error),
    });
  }
  if (
    !issue.node_id ||
    !Number.isSafeInteger(issue.number) ||
    issue.number <= 0
  ) {
    throw new FactoryError({
      code: "integration_issue_create_failed",
      message: "GitHub returned an invalid issue identity",
    });
  }
  return {
    nodeId: issue.node_id,
    number: issue.number,
    url: issue.html_url,
    title,
  };
}

export function restrictGitHubToIssue(
  github: GitHubService,
  nodeId: string,
): GitHubService {
  return {
    discoverCandidates: (repository) =>
      github
        .discoverCandidates(repository)
        .pipe(
          Effect.map((candidates) =>
            candidates.filter((candidate) => candidate.issue.nodeId === nodeId),
          ),
        ),
    claimIssue: (issue) => github.claimIssue(issue),
    verifyPullRequest: (repository, branch, issueNumber) =>
      github.verifyPullRequest(repository, branch, issueNumber),
  };
}

function makeRunId(now: Date, id: string): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${id}`;
}

export function makeSignalWaiter(source: SignalSource = process): SignalWaiter {
  let settled = false;
  let resolveSignal!: (signal: NodeJS.Signals) => void;
  const signal = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const onInterrupt = () => {
    if (!settled) resolveSignal("SIGINT");
    settled = true;
  };
  const onTerminate = () => {
    if (!settled) resolveSignal("SIGTERM");
    settled = true;
  };
  source.on("SIGINT", onInterrupt);
  source.on("SIGTERM", onTerminate);
  return {
    signal,
    dispose: () => {
      source.off("SIGINT", onInterrupt);
      source.off("SIGTERM", onTerminate);
    },
  };
}

function eventSubsequencePresent(snapshot: FactorySnapshot): boolean {
  let expected = 0;
  for (const event of snapshot.events) {
    if (event.type === EXPECTED_EVENTS[expected]) expected += 1;
  }
  return expected === EXPECTED_EVENTS.length;
}

function receiptMatchesIssue(
  receipt: CommandReceipt,
  issue: CreatedIntegrationIssue,
): boolean {
  return (
    receipt.result._tag === "started" &&
    receipt.result.assignment.issue.nodeId === issue.nodeId &&
    receipt.result.assignment.issue.number === issue.number
  );
}

export function checkIntegrationResult(
  receipt: CommandReceipt,
  snapshot: FactorySnapshot,
  issue: CreatedIntegrationIssue,
): { readonly exitCode: number; readonly message: string } {
  if (!receiptMatchesIssue(receipt, issue)) {
    return {
      exitCode: 1,
      message: "failed: dispatcher started the wrong issue",
    };
  }
  const assignment = snapshot.assignment;
  if (
    !assignment ||
    assignment.issue.nodeId !== issue.nodeId ||
    assignment.issue.number !== issue.number
  ) {
    return {
      exitCode: 1,
      message: "failed: snapshot contains the wrong issue",
    };
  }
  if (assignment.state === "failed") {
    return {
      exitCode: 1,
      message: `failed: assignment ${assignment.id} reported ${assignment.error?.code ?? "unknown error"}`,
    };
  }
  if (assignment.state !== "completed") {
    return {
      exitCode: 1,
      message: `failed: assignment ended in ${assignment.state}`,
    };
  }
  if (!eventSubsequencePresent(snapshot)) {
    return {
      exitCode: 1,
      message: "failed: assignment event history is incomplete",
    };
  }
  if (!assignment.pullRequest) {
    return {
      exitCode: 1,
      message: "failed: completed assignment has no verified pull request",
    };
  }
  return {
    exitCode: 0,
    message: `passed: verified ${assignment.pullRequest.url}`,
  };
}

async function waitForTerminalSnapshot(
  url: string,
  getSnapshot: typeof getFactorySnapshot,
  pollIntervalMs: number,
): Promise<FactorySnapshot> {
  for (;;) {
    const snapshot = await getSnapshot(url);
    if (snapshot.assignment && TERMINAL_STATES.has(snapshot.assignment.state)) {
      return snapshot;
    }
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, pollIntervalMs),
    );
  }
}

export async function runLiveIntegration(
  args: ReadonlyArray<string>,
  runtime: IntegrationRuntime = {},
): Promise<number> {
  const runner = runtime.runner ?? nodeCommandRunner;
  const workingDirectory = runtime.workingDirectory ?? process.cwd();
  const parsed = integrationArgumentsFromArgs(args, workingDirectory);
  const integrationConfig = await (runtime.loadConfig ?? loadIntegrationConfig)(
    parsed.configPath,
  );
  await checked(runner, ["vp", "run", "build:console"]);
  const preflight = await preflightIntegration(parsed.repository, runner);
  const runId = makeRunId(
    (runtime.now ?? (() => new Date()))(),
    (runtime.id ?? randomUUID)(),
  );
  const integrationRoot = resolve(workingDirectory, INTEGRATION_ROOT);
  await mkdir(integrationRoot, { recursive: true });
  const retainedDirectory = join(integrationRoot, runId);
  await mkdir(retainedDirectory, { recursive: false });
  const issue = await createIntegrationIssue(preflight, runId, runner);
  const write = runtime.write ?? console.log;
  write(`Run ID: ${runId}`);
  write(`Issue: ${issue.url}`);
  write(`Retained directory: ${retainedDirectory}`);
  const config = {
    repository: parsed.repository,
    databasePath: join(retainedDirectory, "factory.db"),
    workspaceRoot: join(retainedDirectory, "workspaces"),
    bindHost: "127.0.0.1",
    port: 0,
    codex: integrationConfig.codex,
    timeouts: integrationConfig.timeouts,
  };
  const productionGitHub = runtime.github ?? makeGitHubService(runner);
  const github = restrictGitHubToIssue(productionGitHub, issue.nodeId);
  const dependencies = (runtime.dependencies ?? productionDependencies)(
    config,
    github,
  );
  let service: IntegrationService | null = null;
  let signalWaiter: SignalWaiter | null = null;
  try {
    service = await (runtime.startService ?? startFactoryService)(
      config,
      dependencies,
    );
    write(`Console: ${service.url}`);
    const rpcUrl = `${service.url}${RPC_PATH}`;
    const runNext = runtime.runNext ?? runNextEligibleIssue;
    const getSnapshot = runtime.getSnapshot ?? getFactorySnapshot;
    signalWaiter = runtime.waitForSignal
      ? { signal: runtime.waitForSignal, dispose: () => undefined }
      : makeSignalWaiter(runtime.signalSource);
    const signal = signalWaiter.signal;
    const stopped = service.terminated.then(() => ({
      type: "terminated" as const,
    }));
    let result: { readonly exitCode: number; readonly message: string };
    try {
      const submitted = await Promise.race([
        runNext(rpcUrl, `integration-${runId}`).then((receipt) => ({
          type: "submitted" as const,
          receipt,
        })),
        stopped,
        signal.then((name) => ({ type: "signal" as const, name })),
      ]);
      if (submitted.type === "terminated") {
        write("failed: Factory service terminated before inspection completed");
        return 1;
      }
      if (submitted.type === "signal") {
        write(
          `cancelled by ${submitted.name}: a nonterminal assignment may remain retained`,
        );
        return 1;
      }
      if (!receiptMatchesIssue(submitted.receipt, issue)) {
        result = {
          exitCode: 1,
          message: "failed: dispatcher started the wrong issue",
        };
      } else {
        const terminal = waitForTerminalSnapshot(
          rpcUrl,
          getSnapshot,
          runtime.pollIntervalMs ?? 1_000,
        ).then((snapshot) => ({ type: "terminal" as const, snapshot }));
        const first = await Promise.race([
          terminal,
          stopped,
          signal.then((name) => ({ type: "signal" as const, name })),
        ]);
        if (first.type === "terminated") {
          write(
            "failed: Factory service terminated before inspection completed",
          );
          return 1;
        }
        if (first.type === "signal") {
          write(
            `cancelled by ${first.name}: a nonterminal assignment may remain retained`,
          );
          return 1;
        }
        result = checkIntegrationResult(
          submitted.receipt,
          first.snapshot,
          issue,
        );
      }
    } catch (error) {
      result = { exitCode: 1, message: `failed: ${String(error)}` };
    }
    write(result.message);
    write("Factory remains available for inspection. Press Ctrl-C to stop.");
    const retained = await Promise.race([
      stopped,
      signal.then((name) => ({ type: "signal" as const, name })),
    ]);
    if (retained.type === "terminated") {
      write("failed: Factory service terminated during retained inspection");
      return 1;
    }
    return result.exitCode;
  } finally {
    try {
      await service?.stop();
    } finally {
      signalWaiter?.dispose();
    }
  }
}
