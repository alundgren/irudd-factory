import { describe, expect, test } from "vite-plus/test";
import { Schema } from "effect";
import { Assignment, CommandReceipt, isProviderBusy } from "../src/index.ts";

const assignment = {
  id: "assignment-1",
  provider: "codex",
  issue: {
    nodeId: "I_1",
    repository: "owner/repository",
    number: 1,
    url: "https://github.com/owner/repository/issues/1",
    title: "Implement one thing",
  },
  state: "reserved" as const,
  workflow: {
    startingCommit: "a".repeat(40),
    blobId: "b".repeat(40),
    digest: "c".repeat(64),
    body: "Do the work.",
  },
  workspace: null,
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

describe("contracts", () => {
  test("decodes durable receipts at the RPC boundary", () => {
    const decoded = Schema.decodeUnknownSync(CommandReceipt)({
      commandId: "command-1",
      result: { _tag: "started", assignment },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.result._tag).toBe("started");
    expect(Schema.decodeUnknownSync(Assignment)(assignment).id).toBe(
      "assignment-1",
    );
  });

  test("identifies every nonterminal provider state", () => {
    expect(isProviderBusy("reserved")).toBe(true);
    expect(isProviderBusy("starting")).toBe(true);
    expect(isProviderBusy("running")).toBe(true);
    expect(isProviderBusy("completed")).toBe(false);
    expect(isProviderBusy("failed")).toBe(false);
  });
});
