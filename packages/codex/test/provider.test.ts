import { afterEach, describe, expect, test } from "vite-plus/test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { WorkspacePaths } from "@irudd-factory/contracts";
import { FactoryError, type ProviderEvent } from "@irudd-factory/application";
import { makeAssignment } from "./helpers/assignment.ts";
import { Effect, Either, Fiber } from "effect";
import {
  makeCodexProvider,
  terminateOwnedGroup,
  type ManagedProcess,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const fakeServer = join(
  dirname(fileURLToPath(import.meta.url)),
  "helpers",
  "fake-app-server.ts",
);

const preparedCodex = {
  prepareCodex: () =>
    Promise.resolve({
      codexVersion: "codex-cli fake-1.0.0",
      schemaDigest: "d".repeat(64),
    }),
};

async function fixture(mode = "success", options: { turnMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "factory-codex-test-"));
  roots.push(root);
  const worktree = join(root, "worktree");
  const worktreeGit = join(root, "clone", ".git", "worktrees", "assignment-1");
  const commonGit = join(root, "clone", ".git");
  await Promise.all([
    mkdir(worktree, { recursive: true }),
    mkdir(worktreeGit, { recursive: true }),
  ]);
  const workspace: WorkspacePaths = {
    clonePath: join(root, "clone"),
    worktreePath: worktree,
    worktreeGitDir: worktreeGit,
    commonGitDir: commonGit,
    branch: "factory/assignment-1",
  };
  const assignment = makeAssignment(workspace);
  const provider = makeCodexProvider(
    {
      commandPrefix: [process.execPath, fakeServer, mode],
      runtimeRoot: join(root, "runtime"),
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      timeouts: {
        childStartupMs: mode === "initialization-timeout" ? 100 : 2_000,
        initializationMs: 500,
        modelSchemaMs: mode === "model-timeout" ? 100 : 2_000,
        turnMs: options.turnMs ?? (mode === "turn-timeout" ? 50 : 500),
        shutdownMs: 500,
      },
    },
    ["fragmented", "version-failure", "schema-failure"].includes(mode)
      ? {}
      : preparedCodex,
  );
  return { provider, assignment, workspace };
}

describe("Codex provider", () => {
  test("assembles a prepared provider result through fragmented stdio and cleans up its process", async () => {
    const { provider, assignment, workspace } = await fixture("fragmented");
    const events: ProviderEvent[] = [];
    const result = await Effect.runPromise(
      provider.run(
        { assignment, workspace, prompt: "Implement it." },
        (event) => Effect.sync(() => events.push(event)),
      ),
    );
    expect(events.map(({ type }) => type)).toEqual([
      "provider.process.started",
      "provider.settings.observed",
      "provider.thread.started",
      "provider.turn.started",
      "provider.settings.observed",
    ]);
    expect(result).toMatchObject({
      codexVersion: "codex-cli fake-1.0.0",
      threadId: "thread-1",
      turnId: "turn-1",
      observedModel: "gpt-5.6-luna",
      observedEffort: "low",
      finalResponse: "Pull request opened.",
      approvalCount: 0,
    });
    expect(result.processExit.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    const started = events[0]!;
    expect(started.patch).toMatchObject({
      codexVersion: result.codexVersion,
      processStartPending: false,
    });
    expect(started.detail.processStartIdentity).toEqual(expect.any(String));
    expect(started.patch?.processGroupId).toBe(started.detail.pid);
    expect(() => process.kill(started.detail.pid as number, 0)).toThrow();
    expect(events[2]?.detail.schemaDigest).toBe(
      result.processExit.schemaDigest,
    );
    expect(events[1]?.patch?.codexVersion).toBe(result.codexVersion);
    expect(result.records?.map(({ kind }) => kind)).toEqual([
      "item",
      "item",
      "transcript",
      "usage",
      "process_exit",
    ]);
    expect(result.processExit).toMatchObject({ signal: "SIGTERM" });
  });

  test("answers a server approval request over stdin before interrupting and cleaning up", async () => {
    const { provider, assignment, workspace } = await fixture("approval");
    const events: ProviderEvent[] = [];
    const outcome = await Effect.runPromise(
      Effect.either(
        provider.run(
          { assignment, workspace, prompt: "Implement it." },
          (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        ),
      ),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome))
      expect(outcome.left.code).toBe("approval_requested");
    expect(
      JSON.parse(
        await readFile(
          join(workspace.worktreePath, "approval-response.json"),
          "utf8",
        ),
      ),
    ).toEqual({ id: "approval-1", result: { decision: "cancel" } });
    expect(events.at(-1)?.detail.approvalCount).toBe(1);
    expect(events.at(-1)?.records?.map(({ kind }) => kind)).toEqual([
      "error",
      "process_exit",
    ]);
  });

  test("persists observed records before a running turn is interrupted", async () => {
    const { provider, assignment, workspace } = await fixture(
      "retention-pause",
      { turnMs: 5_000 },
    );
    const retained: string[] = [];
    const fiber = Effect.runFork(
      provider.run(
        { assignment, workspace, prompt: "Implement it." },
        () => Effect.void,
        (records) =>
          Effect.sync(() => retained.push(...records.map(({ kind }) => kind))),
      ),
    );
    const deadline = Date.now() + 2_000;
    while (!retained.includes("usage") && Date.now() < deadline) {
      await delay(10);
    }
    expect(retained).toEqual(["item", "item", "transcript", "usage"]);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  for (const [mode, code] of [
    ["malformed", "provider_protocol_error"],
    ["provider-exit", "provider_exited"],
    ["initialization-timeout", "child_startup_timeout"],
    ["thread-timeout", "initialization_timeout"],
    ["model-timeout", "model_schema_timeout"],
    ["turn-timeout", "turn_completion_timeout"],
    ["version-failure", "codex_version_failed"],
    ["schema-failure", "schema_generation_failed"],
  ] as const) {
    test(`reports stdio ${mode} and cleans up the child`, async () => {
      const { provider, assignment, workspace } = await fixture(mode);
      const events: ProviderEvent[] = [];
      const outcome = await Effect.runPromise(
        Effect.either(
          provider.run(
            { assignment, workspace, prompt: "Implement it." },
            (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          ),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (events.length > 0) {
        expect(events.at(-1)?.records?.at(-1)).toMatchObject({
          kind: "process_exit",
          cleanupTimedOut: false,
        });
        expect(() =>
          process.kill(events[0]!.detail.pid as number, 0),
        ).toThrow();
      }
      if (Either.isLeft(outcome)) {
        expect(outcome.left.code).toBe(code);
        if (mode === "version-failure" || mode === "schema-failure") {
          expect(outcome.left.message).not.toContain("sensitive");
          expect(outcome.left.message).not.toContain("stderr");
        }
      }
    });
  }

  for (const [mode, code] of [
    ["post-completion-malformed", "provider_protocol_error"],
    ["post-completion-exit", "provider_exited"],
  ] as const) {
    test(`retains ${mode} during final persistence`, async () => {
      const { provider, assignment, workspace } = await fixture(mode);
      let settingsEvents = 0;
      const outcome = await Effect.runPromise(
        Effect.either(
          provider.run(
            { assignment, workspace, prompt: "Implement it." },
            (event) =>
              Effect.promise(async () => {
                if (event.type === "provider.settings.observed") {
                  settingsEvents += 1;
                  if (settingsEvents === 2) await delay(75);
                }
              }),
          ),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) expect(outcome.left.code).toBe(code);
    });
  }

  test("does not start a second wait after full-budget cleanup", async () => {
    const { assignment, workspace } = await fixture("interrupt-timeout");
    let captured: ManagedProcess | undefined;
    let terminationReturnedAt = 0;
    const patches: Array<string | undefined> = [];
    const provider = makeCodexProvider(
      {
        commandPrefix: [process.execPath, fakeServer, "interrupt-timeout"],
        runtimeRoot: join(dirname(workspace.worktreePath), "deadline-runtime"),
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        timeouts: {
          childStartupMs: 2_000,
          initializationMs: 500,
          modelSchemaMs: 2_000,
          turnMs: 500,
          shutdownMs: 200,
        },
        terminateProcessGroup: async (child, shutdownMs) => {
          captured = child;
          await delay(shutdownMs);
          terminationReturnedAt = performance.now();
          return {
            code: null,
            signal: "SIGKILL",
            cleanupTimedOut: true,
          };
        },
      },
      preparedCodex,
    );
    try {
      const outcome = await Effect.runPromise(
        Effect.either(
          provider.run(
            { assignment, workspace, prompt: "Implement it." },
            (event) =>
              Effect.sync(() => {
                patches.push(event.patch?.state);
              }),
          ),
        ),
      );
      const afterFailureMs = performance.now() - terminationReturnedAt;
      expect(Either.isLeft(outcome)).toBe(true);
      expect(afterFailureMs).toBeLessThan(75);
      expect(captured).toBeDefined();
      expect(patches).toContain("ownership_uncertain");
    } finally {
      if (captured) await terminateOwnedGroup(captured, 500);
    }
  });

  test("does not reset the shutdown deadline after termination rejects", async () => {
    const { assignment, workspace } = await fixture();
    let captured: ManagedProcess | undefined;
    const budgets: number[] = [];
    const provider = makeCodexProvider(
      {
        commandPrefix: [process.execPath, fakeServer, "success"],
        runtimeRoot: join(dirname(workspace.worktreePath), "rejection-runtime"),
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        timeouts: {
          childStartupMs: 2_000,
          initializationMs: 500,
          modelSchemaMs: 2_000,
          turnMs: 500,
          shutdownMs: 200,
        },
        terminateProcessGroup: async (child, shutdownMs) => {
          captured = child;
          budgets.push(shutdownMs);
          if (budgets.length === 1) {
            await delay(120);
            throw new FactoryError({
              code: "provider_failed",
              message: "termination failed",
            });
          }
          return terminateOwnedGroup(child, shutdownMs);
        },
      },
      preparedCodex,
    );
    try {
      const outcome = await Effect.runPromise(
        Effect.either(
          provider.run(
            { assignment, workspace, prompt: "Implement it." },
            () => Effect.void,
          ),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.code).toBe("provider_failed");
      }
      expect(budgets).toHaveLength(2);
      expect(budgets[1]).toBeLessThan(150);
    } finally {
      if (captured) await terminateOwnedGroup(captured, 500);
    }
  });

  test("reports uncertain ownership when every termination attempt rejects", async () => {
    const { assignment, workspace } = await fixture();
    let captured: ManagedProcess | undefined;
    const patches: Array<string | undefined> = [];
    const provider = makeCodexProvider(
      {
        commandPrefix: [process.execPath, fakeServer, "success"],
        runtimeRoot: join(dirname(workspace.worktreePath), "rejection-runtime"),
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        timeouts: {
          childStartupMs: 2_000,
          initializationMs: 500,
          modelSchemaMs: 2_000,
          turnMs: 500,
          shutdownMs: 200,
        },
        terminateProcessGroup: async (child) => {
          captured = child;
          throw new FactoryError({
            code: "provider_failed",
            message: "termination failed",
          });
        },
      },
      preparedCodex,
    );
    try {
      const outcome = await Effect.runPromise(
        Effect.either(
          provider.run(
            { assignment, workspace, prompt: "Implement it." },
            (event) =>
              Effect.sync(() => {
                patches.push(event.patch?.state);
              }),
          ),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left.detail).toBe("cleanup_timeout");
      }
      expect(patches).toContain("ownership_uncertain");
    } finally {
      if (captured) await terminateOwnedGroup(captured, 500);
    }
  });

  test("kills the App Server process group when the run is interrupted mid-turn", async () => {
    const { assignment, workspace } = await fixture("turn-timeout", {
      turnMs: 5_000,
    });
    let captured: ManagedProcess | undefined;
    let terminateCalls = 0;
    const provider = makeCodexProvider(
      {
        commandPrefix: [process.execPath, fakeServer, "turn-timeout"],
        runtimeRoot: join(dirname(workspace.worktreePath), "interrupt-runtime"),
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        timeouts: {
          childStartupMs: 2_000,
          initializationMs: 500,
          modelSchemaMs: 2_000,
          turnMs: 5_000,
          shutdownMs: 500,
        },
        terminateProcessGroup: async (child, shutdownMs) => {
          captured = child;
          terminateCalls += 1;
          return terminateOwnedGroup(child, shutdownMs);
        },
      },
      preparedCodex,
    );
    let turnStarted = false;
    const fiber = Effect.runFork(
      provider.run(
        { assignment, workspace, prompt: "Implement it." },
        (event) =>
          Effect.sync(() => {
            if (event.type === "provider.turn.started") turnStarted = true;
          }),
      ),
    );
    const startDeadline = Date.now() + 2_000;
    while (!turnStarted && Date.now() < startDeadline) await delay(10);
    expect(turnStarted).toBe(true);

    await Effect.runPromise(Fiber.interrupt(fiber));

    const terminateDeadline = Date.now() + 2_000;
    while (terminateCalls === 0 && Date.now() < terminateDeadline) {
      await delay(10);
    }
    expect(terminateCalls).toBe(1);
    expect(captured).toBeDefined();

    const exitDeadline = Date.now() + 2_000;
    const stillRunning = (): boolean => {
      try {
        process.kill(captured!.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (stillRunning() && Date.now() < exitDeadline) await delay(10);
    expect(stillRunning()).toBe(false);
  });
});
