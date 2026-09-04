import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { AdmissionInput, Candidate } from "@irudd-factory/application";
import { RETAINED_TEXT_TRUNCATION_MARKER } from "@irudd-factory/contracts";
import { Effect } from "effect";
import { openStateStore } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "factory-state-test-"));
  roots.push(root);
  return join(root, "factory.db");
}

function candidate(
  nodeId = "I_1",
  number = 1,
  repository = "owner/repository",
): Candidate {
  return {
    issue: {
      nodeId,
      repository,
      number,
      url: `https://github.com/${repository}/issues/${number}`,
      title: `Issue ${number}`,
    },
    workflow: {
      startingCommit: "a".repeat(40),
      blobId: "b".repeat(40),
      digest: "c".repeat(64),
      body: "Do the work.",
    },
  };
}

function admission(
  commandId: string,
  assignmentId: string,
  candidates: ReadonlyArray<Candidate>,
): AdmissionInput {
  return {
    commandId,
    provider: "codex",
    candidates: candidates.map((value) => ({
      ...value,
      requestedModel: "gpt-5.6-luna",
      requestedEffort: "low",
    })),
    assignmentId,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function processIdentity(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!startTime) throw new Error("Test process has no start identity");
  return `${pid}:${startTime}`;
}

function isLiveProcessIdentity(pid: number, identity: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && `${pid}:${fields[19]}` === identity;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  throw new Error(`Process ${pid} did not exit`);
}

describe("SQLite state store", () => {
  test("applies required SQLite settings and forward migration", async () => {
    const opened = openStateStore(await databasePath());
    expect(opened.database.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(opened.database.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(opened.database.prepare("PRAGMA busy_timeout").get()).toEqual({
      timeout: 5000,
    });
    expect(
      (
        opened.database
          .prepare("SELECT version FROM schema_migrations")
          .get() as { version: number } | undefined
      )?.version,
    ).toBe(4);
    opened.close();
  });

  test("replays a durable receipt after reopening", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    const original = await Effect.runPromise(
      first.service.admit(
        admission("command-1", "assignment-1", [candidate()]),
      ),
    );
    first.close();

    const second = openStateStore(path);
    const replay = await Effect.runPromise(
      second.service.getReceipt("command-1"),
    );
    expect(original.created).toBe(true);
    expect(replay).toEqual(original.receipt);
    expect(replay?.result._tag).toBe("started");
    second.close();
  });

  test("persists lifecycle admission, progress, final consequence, and replay", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    await Effect.runPromise(
      first.service.admit(admission("start", "assignment-1", [candidate()])),
    );
    await Effect.runPromise(
      first.service.appendEvent(
        "assignment-1",
        {
          type: "assignment.failed",
          timestamp: "2026-01-01T00:01:00.000Z",
          detail: {},
        },
        { state: "failed" },
      ),
    );
    const attempt = await Effect.runPromise(
      first.service.getAssignment("assignment-1"),
    );
    const admitted = await Effect.runPromise(
      first.service.beginLifecycleCommand({
        commandId: "return-1",
        kind: "return",
        targetAttemptId: "assignment-1",
        expectedTargetVersion: attempt!.lastEventSequence,
        repositoryConfigured: true,
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    expect(admitted.command).toMatchObject({
      phase: "accepted",
      effect: "admitted",
      admission: {
        _tag: "accepted",
        sourceState: "failed",
        sourceVersion: attempt!.lastEventSequence,
      },
    });
    await Effect.runPromise(
      first.service.markLifecycleCommandExecuting(
        "return-1",
        "label_removing",
        "2026-01-01T00:03:00.000Z",
      ),
    );
    first.close();

    const second = openStateStore(path);
    expect(
      await Effect.runPromise(second.service.unfinishedLifecycleCommands()),
    ).toMatchObject([{ commandId: "return-1", effect: "label_removing" }]);
    const replay = await Effect.runPromise(
      second.service.beginLifecycleCommand({
        commandId: "return-1",
        kind: "archive",
        targetAttemptId: "missing",
        expectedTargetVersion: 999,
        repositoryConfigured: false,
        timestamp: "2026-01-01T00:04:00.000Z",
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.command.kind).toBe("return");
    const finished = await Effect.runPromise(
      second.service.finishLifecycleCommand(
        "return-1",
        { _tag: "returned", claimedRemoved: true },
        "2026-01-01T00:05:00.000Z",
      ),
    );
    expect(finished).toMatchObject({
      phase: "final",
      consequence: { _tag: "returned", claimedRemoved: true },
    });
    expect(
      (await Effect.runPromise(second.service.readLifecycleCommands({}))).items,
    ).toEqual([finished]);
    second.close();
  });

  test("archives and restores visibility without deleting retained data", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.admit(admission("start", "assignment-1", [candidate()])),
    );
    await Effect.runPromise(
      opened.service.appendEvent(
        "assignment-1",
        {
          type: "assignment.failed",
          timestamp: "2026-01-01T00:01:00.000Z",
          detail: {},
        },
        { state: "failed" },
      ),
    );
    await Effect.runPromise(
      opened.service.appendProviderRecords("assignment-1", [
        {
          kind: "transcript",
          timestamp: "2026-01-01T00:01:30.000Z",
          text: "Retained work",
        },
      ]),
    );
    let attempt = (await Effect.runPromise(
      opened.service.getAssignment("assignment-1"),
    ))!;
    await Effect.runPromise(
      opened.service.beginLifecycleCommand({
        commandId: "archive-1",
        kind: "archive",
        targetAttemptId: attempt.id,
        expectedTargetVersion: attempt.lastEventSequence,
        repositoryConfigured: true,
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.finishLifecycleCommand(
        "archive-1",
        { _tag: "archived" },
        "2026-01-01T00:02:00.000Z",
        { archivedAt: "2026-01-01T00:02:00.000Z" },
      ),
    );
    expect(
      (await Effect.runPromise(opened.service.readAttempts({}))).items,
    ).toEqual([]);
    expect(
      (
        await Effect.runPromise(
          opened.service.readAttempts({ includeArchived: true }),
        )
      ).items.map(({ id }) => id),
    ).toEqual(["assignment-1"]);
    expect(
      (
        await Effect.runPromise(
          opened.service.readTranscript("assignment-1", {}),
        )
      ).items[0]?.text,
    ).toBe("Retained work");

    attempt = (await Effect.runPromise(
      opened.service.getAssignment("assignment-1"),
    ))!;
    await Effect.runPromise(
      opened.service.beginLifecycleCommand({
        commandId: "restore-1",
        kind: "restore",
        targetAttemptId: attempt.id,
        expectedTargetVersion: attempt.lastEventSequence,
        repositoryConfigured: true,
        timestamp: "2026-01-01T00:03:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.finishLifecycleCommand(
        "restore-1",
        { _tag: "restored" },
        "2026-01-01T00:03:00.000Z",
        { archivedAt: null },
      ),
    );
    expect(
      (await Effect.runPromise(opened.service.readAttempts({}))).items.map(
        ({ id }) => id,
      ),
    ).toEqual(["assignment-1"]);
    opened.close();
  });

  test("keeps a slot occupied after an uncertain stop", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.admit(admission("start", "assignment-1", [candidate()])),
    );
    let attempt = (await Effect.runPromise(
      opened.service.getAssignment("assignment-1"),
    ))!;
    await Effect.runPromise(
      opened.service.beginLifecycleCommand({
        commandId: "stop-1",
        kind: "stop",
        targetAttemptId: attempt.id,
        expectedTargetVersion: attempt.lastEventSequence,
        repositoryConfigured: true,
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.finishLifecycleCommand(
        "stop-1",
        { _tag: "stop_uncertain" },
        "2026-01-01T00:01:00.000Z",
        { state: "stop_uncertain" },
      ),
    );
    const busy = await Effect.runPromise(
      opened.service.admit(
        admission("other", "assignment-2", [candidate("I_2", 2)]),
      ),
    );
    expect(busy.receipt.result._tag).toBe("provider_busy");

    attempt = (await Effect.runPromise(
      opened.service.getAssignment("assignment-1"),
    ))!;
    await Effect.runPromise(
      opened.service.beginLifecycleCommand({
        commandId: "stop-2",
        kind: "stop",
        targetAttemptId: attempt.id,
        expectedTargetVersion: attempt.lastEventSequence,
        repositoryConfigured: true,
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.finishLifecycleCommand(
        "stop-2",
        { _tag: "stopped", processResult: "exited" },
        "2026-01-01T00:02:00.000Z",
        { state: "stopped" },
      ),
    );
    const started = await Effect.runPromise(
      opened.service.admit({
        ...admission("other-2", "assignment-2", [candidate("I_2", 2)]),
        allowRetry: true,
      }),
    );
    expect(started.receipt.result._tag).toBe("started");
    opened.close();
  });

  test("rejects return and restart when repository or pull request rules fail", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.admit(admission("start", "assignment-1", [candidate()])),
    );
    await Effect.runPromise(
      opened.service.appendEvent(
        "assignment-1",
        {
          type: "assignment.failed",
          timestamp: "2026-01-01T00:01:00.000Z",
          detail: {},
        },
        { state: "failed" },
      ),
    );
    let attempt = (await Effect.runPromise(
      opened.service.getAssignment("assignment-1"),
    ))!;
    const absent = await Effect.runPromise(
      opened.service.beginLifecycleCommand({
        commandId: "return-absent",
        kind: "return",
        targetAttemptId: attempt.id,
        expectedTargetVersion: attempt.lastEventSequence,
        repositoryConfigured: false,
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    expect(absent.command).toMatchObject({
      phase: "final",
      consequence: { _tag: "rejected", code: "repository_not_configured" },
    });
    expect(
      await Effect.runPromise(opened.service.getAssignment(attempt.id)),
    ).toEqual(attempt);

    await Effect.runPromise(
      opened.service.appendEvent(
        attempt.id,
        {
          type: "pull_request.reconciled",
          timestamp: "2026-01-01T00:03:00.000Z",
          detail: { evidence: "verified" },
        },
        {
          pullRequest: {
            url: "https://github.com/owner/repository/pull/2",
            number: 2,
            draft: false,
          },
        },
      ),
    );
    attempt = (await Effect.runPromise(
      opened.service.getAssignment("assignment-1"),
    ))!;
    for (const kind of ["return", "restart"] as const) {
      const rejected = await Effect.runPromise(
        opened.service.beginLifecycleCommand({
          commandId: `${kind}-with-pr`,
          kind,
          targetAttemptId: attempt.id,
          expectedTargetVersion: attempt.lastEventSequence,
          repositoryConfigured: true,
          timestamp: "2026-01-01T00:04:00.000Z",
        }),
      );
      expect(rejected.command.consequence).toMatchObject({
        _tag: "rejected",
        code: "pull_request_present",
      });
    }
    opened.close();
  });

  test("persists every rejection without creating an assignment", async () => {
    const opened = openStateStore(await databasePath());
    const empty = await Effect.runPromise(
      opened.service.admit(admission("empty", "unused-1", [])),
    );
    const ambiguous = await Effect.runPromise(
      opened.service.admit(
        admission("ambiguous", "unused-2", [candidate(), candidate("I_2", 2)]),
      ),
    );
    expect(empty.receipt.result._tag).toBe("no_candidate");
    expect(ambiguous.receipt.result._tag).toBe("selection_ambiguous");
    expect(
      (
        opened.database
          .prepare("SELECT count(*) AS count FROM assignments")
          .get() as { count: number } | undefined
      )?.count,
    ).toBe(0);
    opened.close();
  });

  test("enforces immutable issue history and one active provider", async () => {
    const opened = openStateStore(await databasePath());
    const started = await Effect.runPromise(
      opened.service.admit(admission("first", "assignment-1", [candidate()])),
    );
    expect(started.receipt.result._tag).toBe("started");
    const busy = await Effect.runPromise(
      opened.service.admit(
        admission("second", "assignment-2", [candidate("I_2", 2)]),
      ),
    );
    expect(busy.receipt.result._tag).toBe("provider_busy");

    await Effect.runPromise(
      opened.service.appendEvent(
        "assignment-1",
        {
          type: "assignment.failed",
          timestamp: "2026-01-01T00:01:00.000Z",
          detail: {},
        },
        { state: "failed" },
      ),
    );
    const seen = await Effect.runPromise(
      opened.service.admit(admission("third", "assignment-3", [candidate()])),
    );
    expect(seen.receipt.result._tag).toBe("no_candidate");
    opened.close();
  });

  test("holds an exclusive lifetime lease for the database", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    expect(() => openStateStore(path)).toThrow("Another Factory service owns");
    first.close();
    expect(() => openStateStore(path).close()).not.toThrow();
  });

  test("marks only one concurrent same-command admission as created", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    const results = await Promise.all([
      Effect.runPromise(
        first.service.admit(
          admission("same-command", "assignment-a", [candidate()]),
        ),
      ),
      Effect.runPromise(
        first.service.admit(
          admission("same-command", "assignment-b", [candidate()]),
        ),
      ),
    ]);
    expect(
      results
        .map(({ created }) => created)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(results[0]?.receipt).toEqual(results[1]?.receipt);
    first.close();
  });

  test("reserves distinct issues up to the configured slot count", async () => {
    const opened = openStateStore(await databasePath());
    const [first, second] = await Promise.all([
      Effect.runPromise(
        opened.service.admit({
          ...admission("first", "assignment-1", [candidate()]),
          slots: 2,
        }),
      ),
      Effect.runPromise(
        opened.service.admit({
          ...admission("second", "assignment-2", [candidate("I_2", 2)]),
          slots: 2,
        }),
      ),
    ]);
    expect(first.receipt.result._tag).toBe("started");
    expect(second.receipt.result._tag).toBe("started");
    opened.close();
  });

  test("allows a later attempt for a terminal issue when requested", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.admit(admission("first", "assignment-1", [candidate()])),
    );
    await Effect.runPromise(
      opened.service.appendEvent(
        "assignment-1",
        {
          type: "assignment.failed",
          timestamp: "2026-01-01T00:01:00.000Z",
          detail: {},
        },
        { state: "failed" },
      ),
    );
    const retry = await Effect.runPromise(
      opened.service.admit({
        ...admission("retry", "assignment-2", [candidate()]),
        allowRetry: true,
      }),
    );
    expect(retry.receipt.result._tag).toBe("started");
    const issues = await Effect.runPromise(opened.service.readIssues({}));
    const attempts = await Effect.runPromise(opened.service.readAttempts({}));
    expect(issues.items).toHaveLength(1);
    expect(attempts.items.map(({ id }) => id)).toEqual([
      "assignment-2",
      "assignment-1",
    ]);
    opened.close();
  });

  test("retains only projected provider data with redaction and byte limits", async () => {
    const opened = openStateStore(await databasePath(), {
      sensitivePatterns: ["secret-[0-9]+"],
      maxTextBytes: 256,
    });
    await Effect.runPromise(
      opened.service.admit(admission("first", "assignment-1", [candidate()])),
    );
    expect(
      (await Effect.runPromise(opened.service.readUsage({}))).items,
    ).toEqual([]);
    await Effect.runPromise(
      opened.service.appendProviderRecords("assignment-1", [
        {
          kind: "transcript",
          timestamp: "2026-01-01T00:00:01.000Z",
          text: `secret-123 ${"x".repeat(400)}`,
        },
        {
          kind: "item",
          timestamp: "2026-01-01T00:00:02.000Z",
          phase: "completed",
          id: "item-1",
          itemType: "agentMessage",
          status: "completed",
          headers: { authorization: "secret-999" },
          environment: { TOKEN: "secret-456" },
          protocol: { arbitrary: true },
        } as never,
        {
          kind: "usage",
          timestamp: "2026-01-01T00:00:03.000Z",
          usage: {
            total: {
              inputTokens: 10,
              cachedInputTokens: 2,
              outputTokens: 4,
              reasoningOutputTokens: 1,
              totalTokens: 14,
            },
            last: {
              inputTokens: 5,
              cachedInputTokens: 1,
              outputTokens: 2,
              reasoningOutputTokens: 1,
              totalTokens: 7,
            },
            modelContextWindow: null,
          },
        },
      ]),
    );
    const transcript = await Effect.runPromise(
      opened.service.readTranscript("assignment-1", {}),
    );
    expect(transcript.items[0]?.text).not.toContain("secret-123");
    expect(
      transcript.items[0]?.text.endsWith(RETAINED_TEXT_TRUNCATION_MARKER),
    ).toBe(true);
    expect(
      Buffer.byteLength(transcript.items[0]?.text ?? ""),
    ).toBeLessThanOrEqual(256);
    const events = await Effect.runPromise(
      opened.service.readEvents("assignment-1", {}),
    );
    const item = events.items.find(({ type }) => type === "item.completed");
    expect(item?.detail).toEqual({
      id: "item-1",
      itemType: "agentMessage",
      status: "completed",
    });
    expect(JSON.stringify(events)).not.toContain("authorization");
    expect(JSON.stringify(events)).not.toContain("TOKEN");
    expect(
      (await Effect.runPromise(opened.service.readUsage({}))).items[0]?.total
        .totalTokens,
    ).toBe(14);
    expect(
      (
        await Effect.runPromise(
          opened.service.readUsage({ attemptId: "assignment-1" }),
        )
      ).items[0]?.total.totalTokens,
    ).toBe(14);
    expect(
      (
        await Effect.runPromise(
          opened.service.readUsage({ attemptId: "missing-assignment" }),
        )
      ).items,
    ).toEqual([]);
    opened.close();
  });

  test("keeps a paginated traversal fixed while newer attempts arrive", async () => {
    const opened = openStateStore(await databasePath());
    for (const [index, id] of ["assignment-1", "assignment-2"].entries()) {
      await Effect.runPromise(
        opened.service.admit(
          admission(`command-${index}`, id, [
            candidate(`I_${index}`, index + 1),
          ]),
        ),
      );
      await Effect.runPromise(
        opened.service.appendEvent(
          id,
          {
            type: "assignment.failed",
            timestamp: `2026-01-01T00:0${index}:10.000Z`,
            detail: {},
          },
          { state: "failed" },
        ),
      );
    }
    const first = await Effect.runPromise(
      opened.service.readAttempts({ limit: 1 }),
    );
    await Effect.runPromise(
      opened.service.admit(
        admission("command-3", "assignment-3", [candidate("I_3", 3)]),
      ),
    );
    const second = await Effect.runPromise(
      opened.service.readAttempts({
        limit: 1,
        cursor: first.nextCursor ?? 0,
        watermark: first.watermark,
      }),
    );
    expect([...first.items, ...second.items].map(({ id }) => id)).toEqual([
      "assignment-2",
      "assignment-1",
    ]);
    expect(
      (await Effect.runPromise(opened.service.readAttempts({}))).items,
    ).toHaveLength(3);
    opened.close();
  });

  test("orders equal-start timeline pages by end time before id", async () => {
    const opened = openStateStore(await databasePath());
    const expected: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      const id = `equal-start-${String(12 - index).padStart(2, "0")}`;
      expected.push(id);
      await Effect.runPromise(
        opened.service.admit(
          admission(`equal-command-${index}`, id, [
            candidate(`I_equal_${index}`, index + 1),
          ]),
        ),
      );
      await Effect.runPromise(
        opened.service.appendEvent(
          id,
          {
            type: "assignment.completed",
            timestamp: new Date(
              Date.UTC(2026, 0, 1, 0, index + 1),
            ).toISOString(),
            detail: {},
          },
          { state: "completed" },
        ),
      );
    }

    const first = await Effect.runPromise(
      opened.service.readTimeline({ limit: 12 }),
    );
    const second = await Effect.runPromise(
      opened.service.readTimeline({
        limit: 12,
        cursor: first.nextCursor ?? 0,
        watermark: first.watermark,
      }),
    );
    expect([...first.items, ...second.items].map(({ id }) => id)).toEqual(
      expected,
    );
    expect(second.readAt).toBe(first.readAt);
    opened.close();
  });

  test("returns bounded operations data for current attempts", async () => {
    const path = await databasePath();
    const opened = openStateStore(path);
    for (let index = 0; index < 102; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      await Effect.runPromise(
        opened.service.admit({
          ...admission(`command-${suffix}`, `assignment-${suffix}`, [
            candidate(`I_${suffix}`, index + 1),
          ]),
          timestamp,
        }),
      );
      await Effect.runPromise(
        opened.service.appendProviderRecords(`assignment-${suffix}`, [
          {
            kind: "usage",
            timestamp,
            usage: {
              total: {
                inputTokens: index,
                cachedInputTokens: 0,
                outputTokens: 1,
                reasoningOutputTokens: 0,
                totalTokens: index + 1,
              },
              last: {
                inputTokens: index,
                cachedInputTokens: 0,
                outputTokens: 1,
                reasoningOutputTokens: 0,
                totalTokens: index + 1,
              },
              modelContextWindow: null,
            },
          },
        ]),
      );
      if (index < 101) {
        await Effect.runPromise(
          opened.service.appendEvent(
            `assignment-${suffix}`,
            {
              type: "assignment.failed",
              timestamp,
              detail: {},
            },
            { state: "failed" },
          ),
        );
      }
    }
    const database = new DatabaseSync(path);
    database
      .prepare("UPDATE assignments SET updated_at = $updatedAt WHERE id = $id")
      .run({
        id: "assignment-000",
        updatedAt: "2026-01-01T03:00:00.000Z",
      });

    const overview = await Effect.runPromise(
      opened.service.getOperationsOverview(),
    );
    expect(overview.recentActivity).toHaveLength(8);
    expect(overview.recentActivity[0]?.id).toBe("assignment-000");
    expect(overview.recentActivity.map(({ id }) => id)).not.toContain(
      "assignment-001",
    );
    expect(overview.usage.map(({ attemptId }) => attemptId)).toEqual([
      "assignment-101",
    ]);
    expect(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM read_snapshots")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    database.close();
    opened.close();
  });

  test("rejects an incompatible database with a reset diagnostic", async () => {
    const path = await databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT",
    );
    legacy
      .prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES ($version, $appliedAt)",
      )
      .run({ version: 1, appliedAt: "2026-01-01T00:00:00.000Z" });
    legacy.close();
    expect(() => openStateStore(path)).toThrow("must be reset");
  });

  test("marks unfinished attempts interrupted during startup recovery", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    await Effect.runPromise(
      first.service.admit(admission("first", "assignment-1", [candidate()])),
    );
    first.close();

    const recovered = openStateStore(path, { recover: true });
    const assignment = await Effect.runPromise(
      recovered.service.getAssignment("assignment-1"),
    );
    expect(assignment?.state).toBe("interrupted");
    recovered.close();
  });

  test("records one pull request reconciliation without resuming an interrupted attempt", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    await Effect.runPromise(
      first.service.admit(admission("first", "assignment-1", [candidate()])),
    );
    await Effect.runPromise(
      first.service.appendEvent(
        "assignment-1",
        {
          type: "workspace.created",
          timestamp: "2026-01-01T00:00:01.000Z",
          detail: { branch: "factory/assignment-1" },
        },
        {
          workspace: {
            clonePath: "/tmp/clone",
            worktreePath: "/tmp/worktree",
            worktreeGitDir: "/tmp/clone/.git/worktrees/assignment-1",
            commonGitDir: "/tmp/clone/.git",
            branch: "factory/assignment-1",
          },
        },
      ),
    );
    first.close();

    const recovered = openStateStore(path, { recover: true });
    expect(
      (
        await Effect.runPromise(
          recovered.service.pullRequestRecoveryCandidates(),
        )
      ).map(({ id }) => id),
    ).toEqual(["assignment-1"]);
    await Effect.runPromise(
      recovered.service.appendEvent("assignment-1", {
        type: "pull_request.lookup_started",
        timestamp: "2026-01-01T00:00:01.500Z",
        detail: {},
      }),
    );
    expect(
      await Effect.runPromise(
        recovered.service.pullRequestRecoveryCandidates(),
      ),
    ).toEqual([]);
    expect(
      (
        await Effect.runPromise(
          recovered.service.unfinishedPullRequestLookups(),
        )
      ).map(({ id }) => id),
    ).toEqual(["assignment-1"]);
    await Effect.runPromise(
      recovered.service.appendEvent(
        "assignment-1",
        {
          type: "pull_request.reconciled",
          timestamp: "2026-01-01T00:00:02.000Z",
          detail: {
            evidence: "verified",
            pullRequestUrl: "https://github.com/owner/repository/pull/2",
          },
        },
        {
          pullRequest: {
            url: "https://github.com/owner/repository/pull/2",
            number: 2,
            draft: false,
          },
        },
      ),
    );
    expect(
      await Effect.runPromise(
        recovered.service.pullRequestRecoveryCandidates(),
      ),
    ).toEqual([]);
    expect(
      await Effect.runPromise(recovered.service.unfinishedPullRequestLookups()),
    ).toEqual([]);
    expect(
      (await Effect.runPromise(recovered.service.getAssignment("assignment-1")))
        ?.state,
    ).toBe("interrupted");
    recovered.close();
  });

  test("terminates a stored detached process group during recovery", async () => {
    const path = await databasePath();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    const pid = child.pid;
    if (!pid) throw new Error("Test child has no PID");
    child.unref();
    const identity = processIdentity(pid);
    try {
      const first = openStateStore(path);
      await Effect.runPromise(
        first.service.admit(admission("first", "assignment-1", [candidate()])),
      );
      await Effect.runPromise(
        first.service.appendEvent(
          "assignment-1",
          {
            type: "provider.process.started",
            timestamp: "2026-01-01T00:00:01.000Z",
            detail: {},
          },
          {
            processGroupId: pid,
            processStartIdentity: identity,
            processStartPending: false,
          },
        ),
      );
      first.close();

      const recovered = openStateStore(path, { recover: true });
      const assignment = await Effect.runPromise(
        recovered.service.getAssignment("assignment-1"),
      );
      expect(assignment?.state).toBe("interrupted");
      expect(isLiveProcessIdentity(pid, identity)).toBe(false);
      recovered.close();
      await waitForProcessExit(pid);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Recovery normally removed the process group already.
      }
    }
  });

  test("does not finish recovery while a descendant remains in the process group", async () => {
    const path = await databasePath();
    const leader = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["--input-type=module", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(descendant.pid);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const leaderPid = leader.pid;
    if (!leaderPid || !leader.stdout)
      throw new Error("Test leader has no PID or stdout");
    const [chunk] = await once(leader.stdout, "data");
    const descendantPid = Number(String(chunk).trim());
    const leaderIdentity = processIdentity(leaderPid);
    const descendantIdentity = processIdentity(descendantPid);
    leader.unref();
    try {
      const first = openStateStore(path);
      await Effect.runPromise(
        first.service.admit(admission("first", "assignment-1", [candidate()])),
      );
      await Effect.runPromise(
        first.service.appendEvent(
          "assignment-1",
          {
            type: "provider.process.started",
            timestamp: "2026-01-01T00:00:01.000Z",
            detail: {},
          },
          {
            processGroupId: leaderPid,
            processStartIdentity: leaderIdentity,
            processStartPending: false,
          },
        ),
      );
      first.close();

      const recovered = openStateStore(path, { recover: true });
      expect(
        (
          await Effect.runPromise(
            recovered.service.getAssignment("assignment-1"),
          )
        )?.state,
      ).toBe("interrupted");
      expect(isLiveProcessIdentity(leaderPid, leaderIdentity)).toBe(false);
      expect(isLiveProcessIdentity(descendantPid, descendantIdentity)).toBe(
        false,
      );
      recovered.close();
    } finally {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // Recovery normally removed every live member of the process group.
      }
    }
  });

  test("keeps capacity blocked when the saved leader exited but its descendant remains", async () => {
    const path = await databasePath();
    const leader = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["--input-type=module", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(descendant.pid);
setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const leaderPid = leader.pid;
    if (!leaderPid || !leader.stdout)
      throw new Error("Test leader has no PID or stdout");
    const [chunk] = await once(leader.stdout, "data");
    const descendantPid = Number(String(chunk).trim());
    const leaderIdentity = processIdentity(leaderPid);
    const descendantIdentity = processIdentity(descendantPid);
    try {
      const first = openStateStore(path);
      await Effect.runPromise(
        first.service.admit(admission("first", "assignment-1", [candidate()])),
      );
      await Effect.runPromise(
        first.service.appendEvent(
          "assignment-1",
          {
            type: "provider.process.started",
            timestamp: "2026-01-01T00:00:01.000Z",
            detail: {},
          },
          {
            processGroupId: leaderPid,
            processStartIdentity: leaderIdentity,
            processStartPending: false,
          },
        ),
      );
      first.close();

      const leaderClosed = once(leader, "close");
      process.kill(leaderPid, "SIGKILL");
      await leaderClosed;
      expect(isLiveProcessIdentity(descendantPid, descendantIdentity)).toBe(
        true,
      );

      const recovered = openStateStore(path, { recover: true });
      expect(
        (
          await Effect.runPromise(
            recovered.service.getAssignment("assignment-1"),
          )
        )?.state,
      ).toBe("ownership_uncertain");
      expect(isLiveProcessIdentity(descendantPid, descendantIdentity)).toBe(
        true,
      );
      recovered.close();
    } finally {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // Test cleanup removes the surviving descendant process group.
      }
    }
  });

  test("blocks capacity when a crash leaves process start pending", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    await Effect.runPromise(
      first.service.admit(admission("first", "assignment-1", [candidate()])),
    );
    await Effect.runPromise(
      first.service.appendEvent(
        "assignment-1",
        {
          type: "provider.process.start_pending",
          timestamp: "2026-01-01T00:00:01.000Z",
          detail: {},
        },
        { processStartPending: true },
      ),
    );
    first.close();

    const recovered = openStateStore(path, { recover: true });
    const assignment = await Effect.runPromise(
      recovered.service.getAssignment("assignment-1"),
    );
    expect(assignment?.state).toBe("ownership_uncertain");
    const busy = await Effect.runPromise(
      recovered.service.admit(
        admission("second", "assignment-2", [candidate("I_2", 2)]),
      ),
    );
    expect(busy.receipt.result._tag).toBe("provider_busy");
    recovered.close();
  });

  test("keeps capacity blocked when process ownership is uncertain", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.admit(admission("first", "assignment-1", [candidate()])),
    );
    await Effect.runPromise(
      opened.service.appendEvent(
        "assignment-1",
        {
          type: "provider.process.started",
          timestamp: "2026-01-01T00:00:01.000Z",
          detail: {},
        },
        { processGroupId: 1234, processStartIdentity: "1234:5" },
      ),
    );
    await Effect.runPromise(
      opened.service.interruptUnfinished(
        "2026-01-01T00:00:02.000Z",
        () => "uncertain",
      ),
    );
    const assignment = await Effect.runPromise(
      opened.service.getAssignment("assignment-1"),
    );
    expect(assignment?.state).toBe("ownership_uncertain");
    const busy = await Effect.runPromise(
      opened.service.admit(
        admission("second", "assignment-2", [candidate("I_2", 2)]),
      ),
    );
    expect(busy.receipt.result._tag).toBe("provider_busy");
    opened.close();
  });

  test("orders matching observations by repository, issue, and node ID", async () => {
    const opened = openStateStore(await databasePath());
    const timestamp = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "zeta/repository",
        candidates: [{ candidate: candidate("I_z", 7, "zeta/repository") }],
        timestamp,
      }),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "alpha/repository",
        candidates: [
          { candidate: candidate("I_b", 7, "alpha/repository") },
          { candidate: candidate("I_a", 7, "alpha/repository") },
          { candidate: candidate("I_early", 3, "alpha/repository") },
        ],
        timestamp,
      }),
    );
    const queue = await Effect.runPromise(
      opened.service.listQueue({ limit: 10 }),
    );
    expect(queue.items.map(({ issue }) => issue.nodeId)).toEqual([
      "I_early",
      "I_a",
      "I_b",
      "I_z",
    ]);
    opened.close();
  });

  test("persists queue tenure and dispatch controls across restart", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    await Effect.runPromise(
      first.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: candidate() }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      first.service.setDispatchPaused(true, "2026-01-01T00:00:01.000Z"),
    );
    await Effect.runPromise(
      first.service.setCodexEnabled(false, "2026-01-01T00:00:02.000Z"),
    );
    first.close();

    const second = openStateStore(path);
    const queue = await Effect.runPromise(
      second.service.listQueue({ limit: 10 }),
    );
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.eligibleSince).toBe("2026-01-01T00:00:00.000Z");
    expect(await Effect.runPromise(second.service.getDispatchState())).toEqual({
      paused: true,
      codexEnabled: false,
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    second.close();
  });

  test("ends and recreates tenure after eligibility loss", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: candidate() }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [],
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: candidate() }],
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    const queue = await Effect.runPromise(
      opened.service.listQueue({ limit: 10 }),
    );
    expect(queue.items).toHaveLength(2);
    expect(queue.items[0]).toMatchObject({
      startable: true,
      eligibleSince: "2026-01-01T00:02:00.000Z",
    });
    expect(queue.items[1]).toMatchObject({
      startable: false,
      reason: { code: "no_longer_eligible" },
    });
    opened.close();
  });

  test("keeps a queue traversal stable while observations change", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [
          { candidate: candidate("I_1", 1) },
          { candidate: candidate("I_2", 2) },
          { candidate: candidate("I_3", 3) },
        ],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    const first = await Effect.runPromise(
      opened.service.listQueue({ limit: 1 }),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: candidate("I_1", 1) }],
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    );
    const second = await Effect.runPromise(
      opened.service.listQueue({
        limit: 2,
        cursor: first.nextCursor!,
        watermark: first.watermark,
      }),
    );
    expect(second.items.map(({ issue }) => issue.number)).toEqual([2, 3]);
    opened.close();
  });

  test("records eligibility loss for an active issue", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.admit(admission("first", "assignment-1", [candidate()])),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [],
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    );
    expect(
      opened.database
        .prepare(
          `SELECT eligible, reason_code FROM issue_eligibility_observations
           WHERE assignment_id = $assignmentId`,
        )
        .get({ assignmentId: "assignment-1" }),
    ).toEqual({ eligible: 0, reason_code: "no_longer_eligible" });
    expect(
      await Effect.runPromise(
        opened.service.getLatestEligibilityObservation("assignment-1"),
      ),
    ).toMatchObject({
      assignmentId: "assignment-1",
      issueNodeId: "I_1",
      eligible: false,
      reason: { code: "no_longer_eligible" },
    });
    opened.close();
  });

  test("ends tenure for a removed repository and creates new tenure after re-addition", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: candidate() }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.endQueueTenuresOutsideRepositories(
        ["another/repository"],
        "2026-01-01T00:01:00.000Z",
      ),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: candidate() }],
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    const page = await Effect.runPromise(
      opened.service.listQueue({ limit: 10 }),
    );
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      startable: true,
      eligibleSince: "2026-01-01T00:02:00.000Z",
    });
    expect(page.items[1]).toMatchObject({
      startable: false,
      reason: { code: "repository_removed" },
    });
    opened.close();
  });

  test("admits one caller from a queue tenure and rejects a racing reservation", async () => {
    const opened = openStateStore(await databasePath());
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: candidate() }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    const [tenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    expect(tenure).toBeDefined();
    const [first, second] = await Promise.all([
      Effect.runPromise(
        opened.service.admit({
          ...admission("first", "assignment-1", [candidate()]),
          queueTenureId: tenure!.tenureId,
          slots: 2,
          allowRetry: true,
        }),
      ),
      Effect.runPromise(
        opened.service.admit({
          ...admission("second", "assignment-2", [candidate()]),
          queueTenureId: tenure!.tenureId,
          slots: 2,
          allowRetry: true,
        }),
      ),
    ]);
    expect(
      [first.receipt.result._tag, second.receipt.result._tag].sort(),
    ).toEqual(["no_candidate", "started"]);
    expect(
      opened.database
        .prepare("SELECT count(*) AS count FROM assignments")
        .get(),
    ).toEqual({ count: 1 });
    opened.close();
  });

  test("requires an ineligible observation before an admitted issue gets a new tenure", async () => {
    const opened = openStateStore(await databasePath());
    const observed = candidate();
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    const [firstTenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    expect(firstTenure).toBeDefined();
    await Effect.runPromise(
      opened.service.admit({
        ...admission("first", "assignment-1", [observed]),
        queueTenureId: firstTenure!.tenureId,
        slots: 1,
        allowRetry: true,
        source: "automatic",
      }),
    );

    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    );
    expect(
      await Effect.runPromise(opened.service.getDispatchableQueue(10)),
    ).toEqual([]);

    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [],
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:03:00.000Z",
      }),
    );
    const [secondTenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    expect(secondTenure).toMatchObject({
      eligibleSince: "2026-01-01T00:03:00.000Z",
    });
    expect(secondTenure?.tenureId).not.toBe(firstTenure?.tenureId);
    opened.close();
  });

  test("creates one tenure when an interrupted attempt returns before an ineligible poll", async () => {
    const opened = openStateStore(await databasePath());
    const observed = candidate();
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    const [firstTenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    await Effect.runPromise(
      opened.service.admit({
        ...admission("first", "assignment-1", [observed]),
        queueTenureId: firstTenure!.tenureId,
        source: "automatic",
      }),
    );
    const interrupted = await Effect.runPromise(
      opened.service.appendEvent(
        "assignment-1",
        {
          type: "assignment.interrupted",
          timestamp: "2026-01-01T00:01:00.000Z",
          detail: { processReconciliation: "exited" },
        },
        { state: "interrupted" },
      ),
    );
    await Effect.runPromise(
      opened.service.beginLifecycleCommand({
        commandId: "return-1",
        kind: "return",
        targetAttemptId: interrupted.id,
        expectedTargetVersion: interrupted.lastEventSequence,
        repositoryConfigured: true,
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.finishLifecycleCommand(
        "return-1",
        { _tag: "returned", claimedRemoved: true },
        "2026-01-01T00:02:01.000Z",
      ),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:03:00.000Z",
      }),
    );
    const queue = await Effect.runPromise(
      opened.service.getDispatchableQueue(10),
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      eligibleSince: "2026-01-01T00:03:00.000Z",
    });
    expect(queue[0]?.tenureId).not.toBe(firstTenure?.tenureId);
    opened.close();
  });

  test("does not reuse an earlier Return after a newer attempt fails its claim", async () => {
    const opened = openStateStore(await databasePath());
    const observed = candidate();
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    const [firstTenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    await Effect.runPromise(
      opened.service.admit({
        ...admission("first", "assignment-1", [observed]),
        queueTenureId: firstTenure!.tenureId,
        source: "automatic",
      }),
    );
    const interrupted = await Effect.runPromise(
      opened.service.appendEvent(
        "assignment-1",
        {
          type: "assignment.interrupted",
          timestamp: "2026-01-01T00:01:00.000Z",
          detail: { processReconciliation: "exited" },
        },
        { state: "interrupted" },
      ),
    );
    await Effect.runPromise(
      opened.service.beginLifecycleCommand({
        commandId: "return-1",
        kind: "return",
        targetAttemptId: interrupted.id,
        expectedTargetVersion: interrupted.lastEventSequence,
        repositoryConfigured: true,
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.finishLifecycleCommand(
        "return-1",
        { _tag: "returned", claimedRemoved: true },
        "2026-01-01T00:02:01.000Z",
      ),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:03:00.000Z",
      }),
    );
    const [secondTenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    await Effect.runPromise(
      opened.service.admit({
        ...admission("second", "assignment-2", [observed]),
        timestamp: "2026-01-01T00:03:01.000Z",
        queueTenureId: secondTenure!.tenureId,
        source: "automatic",
        allowRetry: true,
      }),
    );
    await Effect.runPromise(
      opened.service.appendEvent(
        "assignment-2",
        {
          type: "assignment.failed",
          timestamp: "2026-01-01T00:04:00.000Z",
          detail: { code: "claim_unconfirmed" },
        },
        {
          state: "failed",
          error: {
            code: "claim_unconfirmed",
            message: "GitHub confirmed that the issue was not claimed",
          },
        },
      ),
    );
    for (const timestamp of [
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:06:00.000Z",
    ]) {
      await Effect.runPromise(
        opened.service.reconcileQueue({
          repository: "owner/repository",
          candidates: [{ candidate: observed }],
          timestamp,
        }),
      );
    }
    expect(
      await Effect.runPromise(opened.service.getDispatchableQueue(10)),
    ).toEqual([]);
    expect(
      opened.database
        .prepare("SELECT count(*) AS count FROM assignments")
        .get(),
    ).toEqual({ count: 2 });
    opened.close();
  });

  test("creates a new tenure after fresh validation records ineligibility", async () => {
    const opened = openStateStore(await databasePath());
    const firstCandidate = candidate();
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: firstCandidate }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    const [firstTenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    await Effect.runPromise(
      opened.service.markQueueTenureIneligible(
        firstTenure!.tenureId,
        "2026-01-01T00:01:00.000Z",
        { code: "issue_ineligible", message: "Workflow revision changed" },
      ),
    );
    const updatedCandidate = {
      ...firstCandidate,
      workflow: {
        ...firstCandidate.workflow,
        digest: "d".repeat(64),
        body: "Implement the updated workflow.",
      },
    };
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: updatedCandidate }],
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    const [secondTenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    expect(secondTenure).toMatchObject({
      eligibleSince: "2026-01-01T00:02:00.000Z",
      workflow: {
        digest: "d".repeat(64),
        body: "Implement the updated workflow.",
      },
    });
    expect(secondTenure?.tenureId).not.toBe(firstTenure?.tenureId);
    opened.close();
  });

  test("records each distinct eligibility-loss cycle for an active issue", async () => {
    const opened = openStateStore(await databasePath());
    const observed = candidate();
    await Effect.runPromise(
      opened.service.admit(admission("first", "assignment-1", [observed])),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [],
        timestamp: "2026-01-01T00:01:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    );
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [],
        timestamp: "2026-01-01T00:03:00.000Z",
      }),
    );
    expect(
      opened.database
        .prepare(
          `SELECT observed_at FROM issue_eligibility_observations
           WHERE assignment_id = $assignmentId ORDER BY sequence`,
        )
        .all({ assignmentId: "assignment-1" }),
    ).toEqual([
      { observed_at: "2026-01-01T00:01:00.000Z" },
      { observed_at: "2026-01-01T00:03:00.000Z" },
    ]);
    opened.close();
  });

  test("does not record eligibility loss when a racing tenure is already admitted", async () => {
    const opened = openStateStore(await databasePath());
    const observed = candidate();
    await Effect.runPromise(
      opened.service.reconcileQueue({
        repository: "owner/repository",
        candidates: [{ candidate: observed }],
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    const [tenure] = await Effect.runPromise(
      opened.service.getDispatchableQueue(1),
    );
    await Effect.runPromise(
      opened.service.admit({
        ...admission("manual", "assignment-1", [observed]),
        queueTenureId: tenure!.tenureId,
      }),
    );
    await Effect.runPromise(
      opened.service.endQueueTenure(
        tenure!.tenureId,
        "2026-01-01T00:01:00.000Z",
        {
          code: "admission_rejected",
          message: "Another command admitted this issue first",
        },
      ),
    );
    expect(
      opened.database
        .prepare("SELECT count(*) AS count FROM issue_eligibility_observations")
        .get(),
    ).toEqual({ count: 0 });
    opened.close();
  });
});
