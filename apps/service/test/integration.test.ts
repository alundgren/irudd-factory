import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Clock,
  GitHub,
  IdGenerator,
  Provider,
  type Candidate,
  type GitHubService,
  type ProviderService,
  Workspaces,
  type WorkspaceService,
} from "@irudd-factory/application";
import {
  ASSIGNMENT_EVENTS,
  type FactorySnapshot,
} from "@irudd-factory/contracts";
import type { CommandResult, CommandRunner } from "@irudd-factory/github";
import { layerStateStore } from "@irudd-factory/state-sqlite";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  checkIntegrationResult,
  createIntegrationIssue,
  DEFAULT_INTEGRATION_REPOSITORY,
  integrationArgumentsFromArgs,
  normalizeGitHubRepository,
  preflightIntegration,
  restrictGitHubToIssue,
  runLiveIntegration,
  type CreatedIntegrationIssue,
  validateIntegrationIssueLabels,
} from "../src/integration.ts";
import type { FactoryConfig } from "../src/config.ts";
import {
  startFactoryService,
  type FactoryDependencies,
} from "../src/service.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const WORKFLOW = `---
required_labels: [ready-for-agent]
forbidden_labels: [claimed, ready-for-human, epic, needs-refinement]
runtime: node
test: vp run test
---

Implement the selected issue.`;

interface RecordedCall {
  readonly args: ReadonlyArray<string>;
  readonly input?: string;
}

class IntegrationRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  failWhen: ((args: ReadonlyArray<string>) => boolean) | null = null;
  invalidJsonWhen: ((args: ReadonlyArray<string>) => boolean) | null = null;
  login = "factory-user";
  permission = "WRITE";
  workflow = WORKFLOW;
  readyLabel = "ready-for-agent";
  claimLabel = "claimed";

  async run(
    args: ReadonlyArray<string>,
    input?: string,
  ): Promise<CommandResult> {
    this.calls.push({ args, ...(input === undefined ? {} : { input }) });
    if (this.failWhen?.(args)) {
      return { stdout: "", stderr: "planned failure", exitCode: 1 };
    }
    if (this.invalidJsonWhen?.(args)) return success("not-json");
    const joined = args.join(" ");
    if (joined === "vp run build:console") return success();
    if (/^(git|gh|codex) --version$/.test(joined)) return success("version\n");
    if (joined === "gh api user") return successJson({ login: this.login });
    if (joined.includes("/collaborators/factory-user/permission")) {
      return successJson({ permission: this.permission });
    }
    if (joined === `gh api repos/${DEFAULT_INTEGRATION_REPOSITORY}`) {
      return successJson({ default_branch: "main" });
    }
    if (joined.includes(`/contents/WORKFLOW.md`)) {
      return successJson({
        sha: "b".repeat(40),
        encoding: "base64",
        content: Buffer.from(this.workflow).toString("base64"),
      });
    }
    if (joined.includes("/labels/ready-for-agent")) {
      return successJson({ name: this.readyLabel });
    }
    if (joined.includes("/labels/claimed")) {
      return successJson({ name: this.claimLabel });
    }
    if (joined.startsWith("git ls-remote --exit-code https://github.com/")) {
      return success(`${"a".repeat(40)}\tHEAD\n`);
    }
    if (
      joined ===
      `gh api --method POST repos/${DEFAULT_INTEGRATION_REPOSITORY}/issues --input -`
    ) {
      return successJson({
        node_id: "I_created",
        number: 73,
        html_url: `https://github.com/${DEFAULT_INTEGRATION_REPOSITORY}/issues/73`,
      });
    }
    throw new Error(`Unexpected command: ${joined}`);
  }
}

function success(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function successJson(value: unknown): CommandResult {
  return success(JSON.stringify(value));
}

function validIntegrationConfig() {
  return {
    codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
    timeouts: {
      childStartupMs: 1_000,
      initializationMs: 1_000,
      modelSchemaMs: 1_000,
      turnMs: 5_000,
      shutdownMs: 1_000,
    },
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeConsoleFixture(root: string): Promise<string> {
  const dist = join(root, "console-dist");
  await mkdir(dist, { recursive: true });
  await writeFile(
    join(dist, "index.html"),
    "<!doctype html><title>Irudd Factory</title>",
  );
  return dist;
}

function issueCreated(runner: IntegrationRunner): boolean {
  return runner.calls.some(
    ({ args }) => args.includes("POST") && args.at(-2)?.endsWith("/issues"),
  );
}

describe("integration arguments and preflight", () => {
  test("normalizes owner/name and HTTPS GitHub repository forms", () => {
    expect(normalizeGitHubRepository("owner/repository")).toBe(
      "owner/repository",
    );
    expect(
      normalizeGitHubRepository("https://github.com/owner/repository.git/"),
    ).toBe("owner/repository");
    expect(() =>
      normalizeGitHubRepository("http://github.com/owner/repository"),
    ).toThrow("Invalid GitHub repository URL");
    expect(() =>
      normalizeGitHubRepository("https://example.com/owner/repository"),
    ).toThrow("Invalid GitHub repository URL");
  });

  test("parses optional config and repository flags", () => {
    expect(integrationArgumentsFromArgs([], "/work")).toEqual({
      configPath: "/work/factory.json",
      repository: DEFAULT_INTEGRATION_REPOSITORY,
    });
    expect(
      integrationArgumentsFromArgs(
        [
          "--repository",
          "https://github.com/owner/repository",
          "--config",
          "factory.local.json",
        ],
        "/work",
      ),
    ).toEqual({
      configPath: "/work/factory.local.json",
      repository: "owner/repository",
    });
    expect(() => integrationArgumentsFromArgs(["--repository"])).toThrow(
      "usage: test:integration",
    );
  });

  test("checks credentials, workflow policy, labels, and the production Git remote", async () => {
    const runner = new IntegrationRunner();
    const preflight = await preflightIntegration(
      DEFAULT_INTEGRATION_REPOSITORY,
      runner,
    );
    expect(preflight.login).toBe("factory-user");
    expect(preflight.workflow.policy.test).toBe("vp run test");
    expect(runner.calls.at(-1)?.args).toEqual([
      "git",
      "ls-remote",
      "--exit-code",
      `https://github.com/${DEFAULT_INTEGRATION_REPOSITORY}.git`,
      "HEAD",
    ]);
  });

  test.each([
    [
      "git executable",
      (args: ReadonlyArray<string>) => args.join(" ") === "git --version",
    ],
    [
      "GitHub executable",
      (args: ReadonlyArray<string>) => args.join(" ") === "gh --version",
    ],
    [
      "Codex executable",
      (args: ReadonlyArray<string>) => args.join(" ") === "codex --version",
    ],
    [
      "GitHub login",
      (args: ReadonlyArray<string>) => args.join(" ") === "gh api user",
    ],
    [
      "repository permission",
      (args: ReadonlyArray<string>) => args.join(" ").includes("/permission"),
    ],
    [
      "repository metadata",
      (args: ReadonlyArray<string>) =>
        args.join(" ") === `gh api repos/${DEFAULT_INTEGRATION_REPOSITORY}`,
    ],
    [
      "workflow fetch",
      (args: ReadonlyArray<string>) =>
        args.join(" ").includes("/contents/WORKFLOW.md"),
    ],
    [
      "required label",
      (args: ReadonlyArray<string>) =>
        args.join(" ").includes("/labels/ready-for-agent"),
    ],
    [
      "claim label",
      (args: ReadonlyArray<string>) =>
        args.join(" ").includes("/labels/claimed"),
    ],
    [
      "Git remote",
      (args: ReadonlyArray<string>) =>
        args.join(" ").startsWith("git ls-remote"),
    ],
  ] as const)(
    "creates no issue when %s preflight fails",
    async (_name, failWhen) => {
      const runner = new IntegrationRunner();
      runner.failWhen = failWhen;
      const root = await temporaryRoot("factory-integration-preflight-");
      await expect(
        runLiveIntegration([], {
          runner,
          workingDirectory: root,
          loadConfig: async () => validIntegrationConfig(),
        }),
      ).rejects.toThrow();
      expect(issueCreated(runner)).toBe(false);
    },
  );

  test("creates no issue when arguments, config, or console build fail", async () => {
    const root = await temporaryRoot("factory-integration-early-");
    const argumentRunner = new IntegrationRunner();
    await expect(
      runLiveIntegration(["--repository"], {
        runner: argumentRunner,
        workingDirectory: root,
      }),
    ).rejects.toThrow("usage: test:integration");
    expect(issueCreated(argumentRunner)).toBe(false);

    const configRunner = new IntegrationRunner();
    await expect(
      runLiveIntegration([], {
        runner: configRunner,
        workingDirectory: root,
        loadConfig: async () => {
          throw new Error("invalid config");
        },
      }),
    ).rejects.toThrow("invalid config");
    expect(issueCreated(configRunner)).toBe(false);

    const buildRunner = new IntegrationRunner();
    buildRunner.failWhen = (args) => args.join(" ") === "vp run build:console";
    await expect(
      runLiveIntegration([], {
        runner: buildRunner,
        workingDirectory: root,
        loadConfig: async () => validIntegrationConfig(),
      }),
    ).rejects.toThrow("vp failed");
    expect(issueCreated(buildRunner)).toBe(false);
  });

  test("creates no issue for insufficient permission or invalid workflow policy", async () => {
    const root = await temporaryRoot("factory-integration-policy-");
    const permissionRunner = new IntegrationRunner();
    permissionRunner.permission = "READ";
    await expect(
      runLiveIntegration([], {
        runner: permissionRunner,
        workingDirectory: root,
        loadConfig: async () => validIntegrationConfig(),
      }),
    ).rejects.toThrow("needs write, maintain, or admin permission");
    expect(issueCreated(permissionRunner)).toBe(false);

    const workflowRunner = new IntegrationRunner();
    workflowRunner.workflow = "invalid workflow";
    await expect(
      runLiveIntegration([], {
        runner: workflowRunner,
        workingDirectory: root,
        loadConfig: async () => validIntegrationConfig(),
      }),
    ).rejects.toThrow("WORKFLOW.md needs YAML front matter");
    expect(issueCreated(workflowRunner)).toBe(false);
  });

  test("creates no issue for invalid GitHub data, an empty login, or wrong labels", async () => {
    const root = await temporaryRoot("factory-integration-data-");
    const invalidJsonRunner = new IntegrationRunner();
    invalidJsonRunner.invalidJsonWhen = (args) =>
      args.join(" ") === "gh api user";
    await expect(
      runLiveIntegration([], {
        runner: invalidJsonRunner,
        workingDirectory: root,
        loadConfig: async () => validIntegrationConfig(),
      }),
    ).rejects.toThrow("invalid response");
    expect(issueCreated(invalidJsonRunner)).toBe(false);

    const emptyLoginRunner = new IntegrationRunner();
    emptyLoginRunner.login = " ";
    await expect(
      runLiveIntegration([], {
        runner: emptyLoginRunner,
        workingDirectory: root,
        loadConfig: async () => validIntegrationConfig(),
      }),
    ).rejects.toThrow("empty ambient user login");
    expect(issueCreated(emptyLoginRunner)).toBe(false);

    for (const label of ["ready", "claim"] as const) {
      const labelRunner = new IntegrationRunner();
      if (label === "ready") labelRunner.readyLabel = "wrong";
      if (label === "claim") labelRunner.claimLabel = "wrong";
      await expect(
        runLiveIntegration([], {
          runner: labelRunner,
          workingDirectory: root,
          loadConfig: async () => validIntegrationConfig(),
        }),
      ).rejects.toThrow("returned the wrong label");
      expect(issueCreated(labelRunner)).toBe(false);
    }
  });

  test("rejects integration labels that workflow policy would not allow", () => {
    expect(() =>
      validateIntegrationIssueLabels({
        requiredLabels: ["ready-for-agent", "integration-only"],
        forbiddenLabels: ["claimed"],
        runtime: "node",
        test: "vp run test",
      }),
    ).toThrow("not eligible under WORKFLOW.md");
    expect(() =>
      validateIntegrationIssueLabels(
        {
          requiredLabels: ["ready-for-agent"],
          forbiddenLabels: ["claimed"],
          runtime: "node",
          test: "vp run test",
        },
        ["ready-for-agent", "claimed"],
      ),
    ).toThrow("not eligible under WORKFLOW.md");
  });

  test.each([
    [
      "required",
      WORKFLOW.replace(
        "required_labels: [ready-for-agent]",
        "required_labels: [ready-for-agent, integration-only]",
      ),
    ],
    [
      "forbidden",
      WORKFLOW.replace(
        "forbidden_labels: [claimed, ready-for-human, epic, needs-refinement]",
        "forbidden_labels: [claimed, ready-for-agent, ready-for-human, epic, needs-refinement]",
      ),
    ],
  ] as const)(
    "creates no issue when WORKFLOW.md has incompatible %s labels",
    async (_policy, workflow) => {
      const root = await temporaryRoot("factory-integration-label-policy-");
      const runner = new IntegrationRunner();
      runner.workflow = workflow;
      await expect(
        runLiveIntegration([], {
          runner,
          workingDirectory: root,
          loadConfig: async () => validIntegrationConfig(),
        }),
      ).rejects.toThrow("WORKFLOW.md");
      expect(issueCreated(runner)).toBe(false);
    },
  );

  test("creates one run-specific issue with the workflow test command", async () => {
    const runner = new IntegrationRunner();
    const preflight = await preflightIntegration(
      DEFAULT_INTEGRATION_REPOSITORY,
      runner,
    );
    const issue = await createIntegrationIssue(preflight, "run-123", runner);
    expect(issue).toMatchObject({ nodeId: "I_created", number: 73 });
    const creation = runner.calls.at(-1);
    expect(creation?.args).toContain("POST");
    expect(JSON.parse(creation?.input ?? "{}")).toEqual({
      title: "Factory integration run-123",
      body: expect.stringContaining("factory-integration-run-123.md"),
      labels: ["ready-for-agent"],
    });
    expect(creation?.input).toContain("vp run test");
  });
});

describe("restricted discovery and terminal checks", () => {
  test("filters by immutable node ID and delegates claim and verification", async () => {
    const calls = { claim: 0, verify: 0 };
    const candidates = [candidate("I_created", 73), candidate("I_other", 74)];
    const base: GitHubService = {
      discoverCandidates: () => Effect.succeed(candidates),
      claimIssue: () =>
        Effect.sync(() => {
          calls.claim += 1;
          return "confirmed" as const;
        }),
      verifyPullRequest: () =>
        Effect.sync(() => {
          calls.verify += 1;
          return {
            url: "https://github.com/o/r/pull/1",
            number: 1,
            draft: false,
          };
        }),
    };
    const restricted = restrictGitHubToIssue(base, "I_created");
    await expect(
      Effect.runPromise(restricted.discoverCandidates("o/r")),
    ).resolves.toEqual([candidates[0]]);
    await Effect.runPromise(restricted.claimIssue(candidates[0]!.issue));
    await Effect.runPromise(restricted.verifyPullRequest("o/r", "branch", 73));
    expect(calls).toEqual({ claim: 1, verify: 1 });
  });

  test("requires the ordered event subsequence and a verified pull request", () => {
    const issue = createdIssue();
    const completed = snapshot("completed", true);
    expect(
      checkIntegrationResult(completed.receipt!, completed, issue),
    ).toEqual({
      exitCode: 0,
      message: "passed: verified https://github.com/o/r/pull/1",
    });
    const withoutPull = snapshot("completed", false);
    expect(
      checkIntegrationResult(withoutPull.receipt!, withoutPull, issue),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("no verified pull request"),
    });
    const failed = snapshot("failed", false);
    expect(
      checkIntegrationResult(failed.receipt!, failed, issue),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("assignment_failed"),
    });

    const wrongReceipt = snapshot("completed", true);
    const wrongReceiptAssignment = {
      ...wrongReceipt.assignment!,
      issue: candidate("I_other", 74).issue,
    };
    expect(
      checkIntegrationResult(
        {
          ...wrongReceipt.receipt!,
          result: { _tag: "started", assignment: wrongReceiptAssignment },
        },
        wrongReceipt,
        issue,
      ),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("dispatcher started the wrong issue"),
    });

    const wrongSnapshot = snapshot("completed", true);
    const otherAssignment = {
      ...wrongSnapshot.assignment!,
      issue: candidate("I_other", 74).issue,
    };
    expect(
      checkIntegrationResult(
        wrongSnapshot.receipt!,
        { ...wrongSnapshot, assignment: otherAssignment },
        issue,
      ),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("snapshot contains the wrong issue"),
    });

    const incomplete = snapshot("completed", true);
    expect(
      checkIntegrationResult(
        incomplete.receipt!,
        {
          ...incomplete,
          events: incomplete.events.filter(
            ({ type }) => type !== ASSIGNMENT_EVENTS.providerTurnStarted,
          ),
        },
        issue,
      ),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("event history is incomplete"),
    });
  });
});

describe("integration orchestration", () => {
  test("runs only the created issue through SQLite and the normal RPC path, then retains the service", async () => {
    const root = await temporaryRoot("factory-integration-orchestration-");
    const consoleDist = await makeConsoleFixture(root);
    const runner = new IntegrationRunner();
    const calls = { claimed: [] as string[], verified: [] as number[] };
    const github = fakeGitHub(calls);
    let stopSignal!: (signal: NodeJS.Signals) => void;
    const waitForSignal = new Promise<NodeJS.Signals>((resolveSignal) => {
      stopSignal = resolveSignal;
    });
    const output: string[] = [];
    const run = runLiveIntegration([], {
      runner,
      github,
      workingDirectory: root,
      loadConfig: async () => validIntegrationConfig(),
      dependencies: fakeDependencies,
      startService: (config, dependencies) =>
        startFactoryService(config, dependencies, consoleDist),
      waitForSignal,
      pollIntervalMs: 1,
      now: () => new Date("2026-09-02T12:00:00.000Z"),
      id: () => "run-id",
      write: (message) => output.push(message),
    });
    await waitUntil(() =>
      output.some((message) => message.includes("remains available")),
    );
    const consoleUrl = output
      .find((message) => message.startsWith("Console:"))
      ?.slice(9);
    expect(consoleUrl).toBeTruthy();
    const consoleResponse = await fetch(consoleUrl!);
    expect(consoleResponse.status).toBe(200);
    expect(await consoleResponse.text()).toContain(
      "<title>Irudd Factory</title>",
    );
    stopSignal("SIGINT");
    await expect(run).resolves.toBe(0);
    expect(calls.claimed).toEqual(["I_created"]);
    expect(calls.verified).toEqual([73]);
    expect(output).toContain(
      "passed: verified https://github.com/alundgren/irudd-factory-agent-testing/pull/99",
    );
  });

  test("cancels an active provider and closes the HTTP service", async () => {
    const root = await temporaryRoot("factory-integration-cancel-");
    const runner = new IntegrationRunner();
    const calls = { claimed: [] as string[], verified: [] as number[] };
    let interrupted = false;
    let stopSignal!: (signal: NodeJS.Signals) => void;
    const waitForSignal = new Promise<NodeJS.Signals>((resolveSignal) => {
      stopSignal = resolveSignal;
    });
    const output: string[] = [];
    const run = runLiveIntegration([], {
      runner,
      github: fakeGitHub(calls),
      workingDirectory: root,
      loadConfig: async () => validIntegrationConfig(),
      dependencies: (config, github) =>
        fakeDependencies(config, github, {
          provider: blockingProvider(() => {
            interrupted = true;
          }),
        }),
      waitForSignal,
      pollIntervalMs: 1,
      write: (message) => output.push(message),
    });
    await waitUntil(() =>
      output.some((message) => message.startsWith("Console:")),
    );
    const consoleUrl = output
      .find((message) => message.startsWith("Console:"))!
      .slice(9);
    await waitUntil(() => calls.claimed.length === 1);
    stopSignal("SIGTERM");
    await expect(run).resolves.toBe(1);
    expect(interrupted).toBe(true);
    await expect(fetch(consoleUrl)).rejects.toThrow();
    expect(
      output.some((message) => message.startsWith("cancelled by SIGTERM")),
    ).toBe(true);
  });

  test("returns nonzero when the service terminates during retained inspection", async () => {
    const root = await temporaryRoot("factory-integration-termination-");
    const runner = new IntegrationRunner();
    let terminate!: () => void;
    let stopCount = 0;
    const terminated = new Promise<void>((resolveTermination) => {
      terminate = resolveTermination;
    });
    const output: string[] = [];
    const run = runLiveIntegration([], {
      runner,
      workingDirectory: root,
      loadConfig: async () => validIntegrationConfig(),
      startService: async () => ({
        url: "http://127.0.0.1:4321",
        terminated,
        stop: async () => {
          stopCount += 1;
        },
      }),
      dependencies: () => null as unknown as FactoryDependencies,
      runNext: async () => snapshot("completed", true).receipt!,
      getSnapshot: async () => snapshot("completed", true),
      waitForSignal: new Promise(() => undefined),
      pollIntervalMs: 1,
      write: (message) => {
        output.push(message);
        if (message.includes("remains available")) terminate();
      },
    });
    await expect(run).resolves.toBe(1);
    expect(stopCount).toBe(1);
    expect(output).toContain(
      "failed: Factory service terminated during retained inspection",
    );
  });

  test("returns a retained failed-assignment status after the stop signal", async () => {
    const root = await temporaryRoot("factory-integration-failed-");
    const runner = new IntegrationRunner();
    let stopSignal!: (signal: NodeJS.Signals) => void;
    const waitForSignal = new Promise<NodeJS.Signals>((resolveSignal) => {
      stopSignal = resolveSignal;
    });
    let stopCount = 0;
    const output: string[] = [];
    const run = runLiveIntegration([], {
      runner,
      workingDirectory: root,
      loadConfig: async () => validIntegrationConfig(),
      startService: async () => ({
        url: "http://127.0.0.1:4321",
        terminated: new Promise(() => undefined),
        stop: async () => {
          stopCount += 1;
        },
      }),
      dependencies: () => null as unknown as FactoryDependencies,
      runNext: async () => snapshot("failed", false).receipt!,
      getSnapshot: async () => snapshot("failed", false),
      waitForSignal,
      pollIntervalMs: 1,
      write: (message) => {
        output.push(message);
        if (message.includes("remains available")) stopSignal("SIGINT");
      },
    });
    await expect(run).resolves.toBe(1);
    expect(stopCount).toBe(1);
    expect(output).toContain(
      "failed: assignment integration-assignment reported assignment_failed",
    );
  });

  test("stops after premature service termination without waiting for a signal", async () => {
    const root = await temporaryRoot("factory-integration-premature-");
    const runner = new IntegrationRunner();
    let stopCount = 0;
    const output: string[] = [];
    const run = runLiveIntegration([], {
      runner,
      workingDirectory: root,
      loadConfig: async () => validIntegrationConfig(),
      startService: async () => ({
        url: "http://127.0.0.1:4321",
        terminated: Promise.resolve(),
        stop: async () => {
          stopCount += 1;
        },
      }),
      dependencies: () => null as unknown as FactoryDependencies,
      runNext: () => new Promise(() => undefined),
      getSnapshot: async () => snapshot("completed", true),
      waitForSignal: new Promise(() => undefined),
      write: (message) => output.push(message),
    });
    await expect(run).resolves.toBe(1);
    expect(stopCount).toBe(1);
    expect(output).toContain(
      "failed: Factory service terminated before inspection completed",
    );
  });

  test.each(["submission", "polling"] as const)(
    "retains an RPC %s failure and stops exactly once after the signal",
    async (failure) => {
      const root = await temporaryRoot(`factory-integration-rpc-${failure}-`);
      const runner = new IntegrationRunner();
      let stopSignal!: (signal: NodeJS.Signals) => void;
      const waitForSignal = new Promise<NodeJS.Signals>((resolveSignal) => {
        stopSignal = resolveSignal;
      });
      let stopCount = 0;
      const output: string[] = [];
      const run = runLiveIntegration([], {
        runner,
        workingDirectory: root,
        loadConfig: async () => validIntegrationConfig(),
        startService: async () => ({
          url: "http://127.0.0.1:4321",
          terminated: new Promise(() => undefined),
          stop: async () => {
            stopCount += 1;
          },
        }),
        dependencies: () => null as unknown as FactoryDependencies,
        runNext: async () => {
          if (failure === "submission") throw new Error("submission failed");
          return snapshot("completed", true).receipt!;
        },
        getSnapshot: async () => {
          throw new Error("polling failed");
        },
        waitForSignal,
        pollIntervalMs: 1,
        write: (message) => {
          output.push(message);
          if (message.includes("remains available")) stopSignal("SIGINT");
        },
      });
      await expect(run).resolves.toBe(1);
      expect(stopCount).toBe(1);
      expect(output).toContain(`failed: Error: ${failure} failed`);
    },
  );

  test("keeps signal handlers installed until slow shutdown finishes", async () => {
    const root = await temporaryRoot("factory-integration-repeat-signal-");
    const runner = new IntegrationRunner();
    const signalSource = new EventEmitter();
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolveStop) => {
      releaseStop = resolveStop;
    });
    let stopCount = 0;
    const output: string[] = [];
    const run = runLiveIntegration([], {
      runner,
      workingDirectory: root,
      loadConfig: async () => validIntegrationConfig(),
      startService: async () => ({
        url: "http://127.0.0.1:4321",
        terminated: new Promise(() => undefined),
        stop: async () => {
          stopCount += 1;
          await stopGate;
        },
      }),
      dependencies: () => null as unknown as FactoryDependencies,
      runNext: () => new Promise(() => undefined),
      getSnapshot: async () => snapshot("completed", true),
      signalSource,
      write: (message) => output.push(message),
    });
    await waitUntil(() =>
      output.some((message) => message.startsWith("Console:")),
    );
    signalSource.emit("SIGINT");
    await waitUntil(() => stopCount === 1);
    signalSource.emit("SIGINT");
    expect(signalSource.listenerCount("SIGINT")).toBe(1);
    expect(signalSource.listenerCount("SIGTERM")).toBe(1);
    releaseStop();
    await expect(run).resolves.toBe(1);
    expect(stopCount).toBe(1);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });
});

function candidate(nodeId: string, number: number): Candidate {
  return {
    issue: {
      nodeId,
      repository: DEFAULT_INTEGRATION_REPOSITORY,
      number,
      url: `https://github.com/${DEFAULT_INTEGRATION_REPOSITORY}/issues/${number}`,
      title: `Issue ${number}`,
    },
    workflow: {
      startingCommit: "a".repeat(40),
      blobId: "b".repeat(40),
      digest: "c".repeat(64),
      body: "Implement the issue.",
    },
  };
}

function createdIssue(): CreatedIntegrationIssue {
  return {
    nodeId: "I_created",
    number: 73,
    url: `https://github.com/${DEFAULT_INTEGRATION_REPOSITORY}/issues/73`,
    title: "Factory integration test",
  };
}

function fakeGitHub(calls: {
  claimed: string[];
  verified: number[];
}): GitHubService {
  return {
    discoverCandidates: () =>
      Effect.succeed([candidate("I_other", 72), candidate("I_created", 73)]),
    claimIssue: (issue) =>
      Effect.sync(() => {
        calls.claimed.push(issue.nodeId);
        return "confirmed" as const;
      }),
    verifyPullRequest: (_repository, _branch, issueNumber) =>
      Effect.sync(() => {
        calls.verified.push(issueNumber);
        return {
          url: `https://github.com/${DEFAULT_INTEGRATION_REPOSITORY}/pull/99`,
          number: 99,
          draft: false,
        };
      }),
  };
}

function completedProvider(): ProviderService {
  return {
    run: (_input, emit) =>
      Effect.gen(function* () {
        yield* emit({
          type: ASSIGNMENT_EVENTS.providerThreadStarted,
          timestamp: "2026-09-02T12:00:01.000Z",
          detail: { threadId: "thread-1" },
          patch: {
            state: "running",
            threadId: "thread-1",
            codexVersion: "codex fixture",
            observedModel: "gpt-5.6-luna",
            observedEffort: "low",
          },
        });
        yield* emit({
          type: ASSIGNMENT_EVENTS.providerTurnStarted,
          timestamp: "2026-09-02T12:00:02.000Z",
          detail: { turnId: "turn-1" },
          patch: { turnId: "turn-1" },
        });
        return providerResult();
      }),
  };
}

function blockingProvider(onInterrupt: () => void): ProviderService {
  return {
    run: (_input, emit) =>
      Effect.gen(function* () {
        yield* emit({
          type: ASSIGNMENT_EVENTS.providerThreadStarted,
          timestamp: "2026-09-02T12:00:01.000Z",
          detail: { threadId: "thread-1" },
          patch: { state: "running", threadId: "thread-1" },
        });
        return yield* Effect.never;
      }).pipe(Effect.onInterrupt(() => Effect.sync(onInterrupt))),
  };
}

function providerResult() {
  const usage = {
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    totalTokens: 15,
  };
  return {
    codexVersion: "codex fixture",
    threadId: "thread-1",
    turnId: "turn-1",
    observedModel: "gpt-5.6-luna",
    observedEffort: "low",
    finalResponse: "Opened the pull request.",
    itemSummaries: [],
    tokenUsage: { total: usage, last: usage, modelContextWindow: null },
    approvalCount: 0,
    processExit: { code: 0, signal: null },
  };
}

function fakeDependencies(
  config: FactoryConfig,
  github: GitHubService,
  overrides: { readonly provider?: ProviderService } = {},
): FactoryDependencies {
  const workspaces: WorkspaceService = {
    create: ({ assignmentId }) =>
      Effect.succeed({
        clonePath: "/tmp/clone",
        worktreePath: `/tmp/${assignmentId}`,
        worktreeGitDir: `/tmp/clone/.git/worktrees/${assignmentId}`,
        commonGitDir: "/tmp/clone/.git",
        branch: `factory/${assignmentId}`,
      }),
  };
  return Layer.mergeAll(
    layerStateStore(config.databasePath),
    Layer.succeed(GitHub, github),
    Layer.succeed(Workspaces, workspaces),
    Layer.succeed(Provider, overrides.provider ?? completedProvider()),
    Layer.succeed(Clock, { now: () => "2026-09-02T12:00:00.000Z" }),
    Layer.succeed(IdGenerator, {
      assignmentId: () => "integration-assignment",
    }),
  );
}

function snapshot(
  state: "completed" | "failed",
  withPull: boolean,
): FactorySnapshot {
  const issue = candidate("I_created", 73).issue;
  const workflow = candidate("I_created", 73).workflow;
  const assignment = {
    id: "integration-assignment",
    provider: "codex",
    issue,
    state,
    workflow,
    workspace: null,
    requestedModel: "gpt-5.6-luna",
    requestedEffort: "low",
    observedModel: null,
    observedEffort: null,
    codexVersion: null,
    threadId: null,
    turnId: null,
    pullRequest: withPull
      ? { url: "https://github.com/o/r/pull/1", number: 1, draft: false }
      : null,
    error:
      state === "failed"
        ? { code: "assignment_failed", message: "planned failure" }
        : null,
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    lastEventSequence: 7,
  } as const;
  const events = [
    ASSIGNMENT_EVENTS.reserved,
    ASSIGNMENT_EVENTS.providerStartRequested,
    ASSIGNMENT_EVENTS.workspaceCreated,
    ASSIGNMENT_EVENTS.providerThreadStarted,
    ASSIGNMENT_EVENTS.providerTurnStarted,
    ASSIGNMENT_EVENTS.providerTurnFinished,
    ...(state === "completed"
      ? [ASSIGNMENT_EVENTS.completed]
      : [ASSIGNMENT_EVENTS.failed]),
  ].map((type, index) => ({
    sequence: index + 1,
    assignmentId: assignment.id,
    type,
    timestamp: assignment.updatedAt,
    detail: {},
  }));
  return {
    receipt: {
      commandId: "integration-command",
      result: { _tag: "started", assignment },
      createdAt: assignment.createdAt,
    },
    assignment,
    events,
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}
