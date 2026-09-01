import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

function candidate(nodeId = "I_1", number = 1): Candidate {
  return {
    issue: {
      nodeId,
      repository: "owner/repository",
      number,
      url: `https://github.com/owner/repository/issues/${number}`,
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
    candidates,
    assignmentId,
    requestedModel: "gpt-5.6-luna",
    requestedEffort: "low",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("SQLite state store", () => {
  test("applies required SQLite settings and forward migration", async () => {
    const opened = openStateStore(await databasePath());
    expect(opened.database.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(opened.database.query("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(opened.database.query("PRAGMA busy_timeout").get()).toEqual({
      timeout: 5000,
    });
    expect(
      opened.database
        .query<{ version: number }, []>("SELECT version FROM schema_migrations")
        .get()?.version,
    ).toBe(1);
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
      opened.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM assignments",
        )
        .get()?.count,
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

  test("serializes different commands into one assignment", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    const second = openStateStore(path);
    const results = await Promise.all([
      Effect.runPromise(
        first.service.admit(
          admission("command-a", "assignment-a", [candidate()]),
        ),
      ),
      Effect.runPromise(
        second.service.admit(
          admission("command-b", "assignment-b", [candidate()]),
        ),
      ),
    ]);
    expect(results.map(({ receipt }) => receipt.result._tag).sort()).toEqual([
      "provider_busy",
      "started",
    ]);
    expect(
      first.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM assignments",
        )
        .get()?.count,
    ).toBe(1);
    first.close();
    second.close();
  });

  test("marks only one concurrent same-command admission as created", async () => {
    const path = await databasePath();
    const first = openStateStore(path);
    const second = openStateStore(path);
    const results = await Promise.all([
      Effect.runPromise(
        first.service.admit(
          admission("same-command", "assignment-a", [candidate()]),
        ),
      ),
      Effect.runPromise(
        second.service.admit(
          admission("same-command", "assignment-b", [candidate()]),
        ),
      ),
    ]);
    expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(results[0]?.receipt).toEqual(results[1]?.receipt);
    first.close();
    second.close();
  });
});
