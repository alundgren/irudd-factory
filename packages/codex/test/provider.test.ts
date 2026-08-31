import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { Assignment, WorkspacePaths } from "@irudd-factory/contracts";
import type { AssignmentPatch } from "@irudd-factory/application";
import { Effect, Either } from "effect";
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

async function fixture(mode = "success") {
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
  const assignment: Assignment = {
    id: "assignment-1",
    provider: "codex",
    issue: {
      nodeId: "I_1",
      repository: "owner/repository",
      number: 1,
      url: "https://github.com/owner/repository/issues/1",
      title: "Issue",
    },
    state: "starting",
    workflow: {
      startingCommit: "a".repeat(40),
      blobId: "b".repeat(40),
      digest: "c".repeat(64),
      body: "Do the work.",
    },
    workspace,
    requestedModel: "gpt-5.6-luna",
    requestedEffort: "low",
    observedModel: null,
    observedEffort: null,
    codexVersion: null,
    threadId: null,
    turnId: null,
    pullRequest: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastEventSequence: 1,
  };
  const provider = makeCodexProvider({
    commandPrefix: [process.execPath, fakeServer, mode],
    runtimeRoot: join(root, "runtime"),
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    timeouts: {
      childStartupMs: 500,
      initializationMs: 500,
      modelSchemaMs: 500,
      turnMs: mode === "turn-timeout" ? 50 : 500,
      shutdownMs: 500,
    },
  });
  return { provider, assignment, workspace };
}

describe("Codex provider", () => {
  test("normalizes a complete App Server lifecycle", async () => {
    const { provider, assignment, workspace } = await fixture();
    const events: string[] = [];
    const result = await Effect.runPromise(
      provider.run(
        { assignment, workspace, prompt: "Implement it." },
        (event) => Effect.sync(() => events.push(event.type)),
      ),
    );
    expect(events).toEqual([
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
      tokenUsage: {
        total: {
          inputTokens: 12,
          cachedInputTokens: 2,
          outputTokens: 7,
          reasoningOutputTokens: 3,
          totalTokens: 19,
        },
        last: {
          inputTokens: 4,
          cachedInputTokens: 1,
          outputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: 6,
        },
        modelContextWindow: 114000,
      },
    });
    expect(result.itemSummaries).toHaveLength(2);
    expect(result.processExit).toMatchObject({ signal: "SIGTERM" });
  });

  for (const [mode, code] of [
    ["approval", "approval_requested"],
    ["reroute", "model_rerouted"],
    ["model-mismatch", "observed_model_mismatch"],
    ["effort-mismatch", "observed_effort_mismatch"],
    ["effort-missing", "observed_effort_missing"],
    ["malformed", "provider_protocol_error"],
    ["provider-error", "provider_error_notification"],
    ["early-error", "provider_error_notification"],
    ["provider-exit", "provider_exited"],
    ["initialization-timeout", "child_startup_timeout"],
    ["thread-timeout", "initialization_timeout"],
    ["model-timeout", "model_schema_timeout"],
    ["turn-timeout", "turn_completion_timeout"],
    ["version-failure", "codex_version_failed"],
    ["schema-failure", "schema_generation_failed"],
  ] as const) {
    test(`normalizes ${mode}`, async () => {
      const { provider, assignment, workspace } = await fixture(mode);
      const outcome = await Effect.runPromise(
        Effect.either(
          provider.run(
            { assignment, workspace, prompt: "Implement it." },
            () => Effect.void,
          ),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) expect(outcome.left.code).toBe(code);
    });
  }

  test("emits observed mismatch values before failing", async () => {
    for (const [mode, field, value] of [
      ["model-mismatch", "observedModel", "another-model"],
      ["effort-mismatch", "observedEffort", "high"],
    ] as const) {
      const { provider, assignment, workspace } = await fixture(mode);
      const patches: AssignmentPatch[] = [];
      await Effect.runPromise(
        Effect.either(
          provider.run(
            { assignment, workspace, prompt: "Implement it." },
            (event) =>
              Effect.sync(() => {
                if (event.patch) patches.push(event.patch);
              }),
          ),
        ),
      );
      expect(patches.some((patch) => patch[field] === value)).toBe(true);
    }
  });

  test("retains the final response on a late validation failure", async () => {
    const { provider, assignment, workspace } = await fixture("effort-missing");
    const failures: Array<Readonly<Record<string, unknown>>> = [];
    await Effect.runPromise(
      Effect.either(
        provider.run(
          { assignment, workspace, prompt: "Implement it." },
          (event) =>
            Effect.sync(() => {
              if (event.type === "provider.failed") {
                failures.push(event.detail);
              }
            }),
        ),
      ),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.finalResponse).toBe("Pull request opened.");
  });

  test("stops before persistence when an RPC response is followed by a terminal event", async () => {
    const { provider, assignment, workspace } = await fixture(
      "response-then-error",
    );
    const events: string[] = [];
    const outcome = await Effect.runPromise(
      Effect.either(
        provider.run(
          { assignment, workspace, prompt: "Implement it." },
          (event) => Effect.sync(() => events.push(event.type)),
        ),
      ),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left.code).toBe("provider_error_notification");
    }
    expect(events).toEqual(["provider.process.started", "provider.failed"]);
  });

  for (const [mode, code] of [
    ["post-completion-error", "provider_error_notification"],
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
                  if (settingsEvents === 2) await Bun.sleep(75);
                }
              }),
          ),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) expect(outcome.left.code).toBe(code);
    });
  }

  test("does not retain command stderr in normalized failures", async () => {
    for (const mode of ["version-failure", "schema-failure"]) {
      const { provider, assignment, workspace } = await fixture(mode);
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
        expect(outcome.left.message).not.toContain("sensitive");
        expect(outcome.left.message).not.toContain("stderr");
      }
    }
  });

  test("does not start a second wait after full-budget cleanup", async () => {
    const { assignment, workspace } = await fixture("interrupt-timeout");
    let captured: ManagedProcess | undefined;
    let terminationReturnedAt = 0;
    const provider = makeCodexProvider({
      commandPrefix: [process.execPath, fakeServer, "interrupt-timeout"],
      runtimeRoot: join(dirname(workspace.worktreePath), "deadline-runtime"),
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      timeouts: {
        childStartupMs: 500,
        initializationMs: 500,
        modelSchemaMs: 500,
        turnMs: 500,
        shutdownMs: 200,
      },
      terminateProcessGroup: async (child, shutdownMs) => {
        captured = child;
        await Bun.sleep(shutdownMs);
        terminationReturnedAt = performance.now();
        return {
          code: null,
          signal: "SIGKILL",
          cleanupTimedOut: true,
        };
      },
    });
    try {
      const outcome = await Effect.runPromise(
        Effect.either(
          provider.run(
            { assignment, workspace, prompt: "Implement it." },
            () => Effect.void,
          ),
        ),
      );
      const afterFailureMs = performance.now() - terminationReturnedAt;
      expect(Either.isLeft(outcome)).toBe(true);
      expect(afterFailureMs).toBeLessThan(75);
      expect(captured).toBeDefined();
    } finally {
      if (captured) await terminateOwnedGroup(captured, 500);
    }
  });

  test("does not reset the shutdown deadline after termination rejects", async () => {
    const { assignment, workspace } = await fixture();
    let captured: ManagedProcess | undefined;
    const budgets: number[] = [];
    const provider = makeCodexProvider({
      commandPrefix: [process.execPath, fakeServer, "success"],
      runtimeRoot: join(dirname(workspace.worktreePath), "rejection-runtime"),
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      timeouts: {
        childStartupMs: 500,
        initializationMs: 500,
        modelSchemaMs: 500,
        turnMs: 500,
        shutdownMs: 200,
      },
      terminateProcessGroup: async (child, shutdownMs) => {
        captured = child;
        budgets.push(shutdownMs);
        if (budgets.length === 1) {
          await Bun.sleep(120);
          throw new Error("termination failed");
        }
        return terminateOwnedGroup(child, shutdownMs);
      },
    });
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
});
