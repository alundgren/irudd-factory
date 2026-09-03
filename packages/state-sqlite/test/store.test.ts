import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { AdmissionInput, Candidate } from "@irudd-factory/application";
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
    ).toBe(3);
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
            processStartIdentity: processIdentity(pid),
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
