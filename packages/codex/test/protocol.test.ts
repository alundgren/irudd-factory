import { onTestFinished, describe, expect, test } from "vite-plus/test";
import { Effect } from "effect";
import { FactoryError, type ProviderEvent } from "@irudd-factory/application";
import type { RetainedProviderRecord } from "@irudd-factory/contracts";
import { createProtocolRun } from "../src/protocol.ts";
import { APP_SERVER_METHODS } from "../src/connection.ts";
import { makeAssignment } from "./helpers/assignment.ts";
import { InMemoryConnection } from "./helpers/in-memory-connection.ts";

function fixture(
  mode = "success",
  options: {
    emit?: (
      event: ProviderEvent,
      connection: InMemoryConnection,
    ) => Promise<void>;
    retain?: (records: ReadonlyArray<RetainedProviderRecord>) => void;
  } = {},
) {
  const workspace = {
    clonePath: "/fixture/clone",
    worktreePath: "/fixture/worktree",
    worktreeGitDir: "/fixture/clone/.git/worktrees/assignment-1",
    commonGitDir: "/fixture/clone/.git",
    branch: "factory/assignment-1",
  };
  const connection = new InMemoryConnection(mode);
  const events: ProviderEvent[] = [];
  const controller = new AbortController();
  const protocol = createProtocolRun(
    connection,
    {
      assignment: makeAssignment(workspace),
      workspace,
      prompt: "Implement it.",
    },
    (event) =>
      Effect.promise(async () => {
        events.push(event);
        await options.emit?.(event, connection);
      }),
    options.retain
      ? (records) => Effect.sync(() => options.retain!(records))
      : undefined,
    {
      timeouts: {
        childStartupMs: 500,
        initializationMs: 500,
        modelSchemaMs: 500,
        turnMs: 500,
      },
    },
    controller.signal,
  );
  onTestFinished(async () => {
    protocol.dispose();
    await connection.dispose();
    expect(connection.activeCount).toBe(0);
  });
  return { protocol, connection, events, controller };
}

describe("Codex protocol with a fresh in-memory connection", () => {
  test("normalizes a complete protocol outcome without process state", async () => {
    const { protocol, connection, events } = fixture();
    const result = await protocol.run();
    expect(result).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      observedModel: "gpt-5.6-luna",
      observedEffort: "low",
      finalResponse: "Pull request opened.",
      approvalCount: 0,
      reroutes: [],
      itemSummaries: [
        { phase: "started", id: "item-1", type: "agentMessage" },
        {
          phase: "completed",
          id: "item-1",
          type: "agentMessage",
          status: "completed",
        },
      ],
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
      records: [
        {
          kind: "item",
          timestamp: expect.any(String),
          phase: "started",
          id: "item-1",
          itemType: "agentMessage",
        },
        {
          kind: "item",
          timestamp: expect.any(String),
          phase: "completed",
          id: "item-1",
          itemType: "agentMessage",
          status: "completed",
        },
        {
          kind: "transcript",
          timestamp: expect.any(String),
          text: "Pull request opened.",
        },
        {
          kind: "usage",
          timestamp: expect.any(String),
          usage: expect.any(Object),
        },
      ],
    });
    expect(result.records[3]).toMatchObject({ usage: result.tokenUsage });
    expect(events.map(({ type }) => type)).toEqual([
      "provider.settings.observed",
      "provider.thread.started",
      "provider.turn.started",
      "provider.settings.observed",
    ]);
    expect(connection.sent.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "thread/start",
      "turn/start",
    ]);
    expect(connection.sent[0]).toMatchObject({
      id: 1,
      params: { capabilities: { experimentalApi: true } },
    });
    expect(connection.sent[3]?.params).toMatchObject({
      model: "gpt-5.6-luna",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: {
        model_reasoning_effort: "low",
        apps: { _default: { enabled: false } },
      },
    });
    expect(connection.sent[4]?.params).toMatchObject({
      effort: "low",
      input: [{ type: "text", text: "Implement it." }],
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [
          "/fixture/worktree",
          "/fixture/clone/.git/worktrees/assignment-1",
          "/fixture/clone/.git",
        ],
        networkAccess: true,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
    });
    expect(events[0]?.patch?.observedEffort).toBe("low");
  });

  test("isolates request IDs, listeners, and terminal state between simultaneous runs", async () => {
    const failed = fixture("early-error");
    const successful = fixture();
    const results = await Promise.allSettled([
      failed.protocol.run(),
      successful.protocol.run(),
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { code: "provider_error_notification" },
    });
    expect(results[1]).toMatchObject({
      status: "fulfilled",
      value: { finalResponse: "Pull request opened." },
    });
    expect(failed.connection.sent[0]?.id).toBe(1);
    expect(successful.connection.sent[0]?.id).toBe(1);
    expect(failed.protocol.snapshot().finalResponse).toBe("");
    expect(failed.events).toEqual([]);
    expect(successful.events).toHaveLength(4);
  });

  test("leaves unreported token usage unknown", async () => {
    const { protocol } = fixture("no-usage");
    const result = await protocol.run();
    expect(result.tokenUsage).toBeNull();
    expect(result.records.some(({ kind }) => kind === "usage")).toBe(false);
  });

  test.each(["subagent-noise", "subagent-early-completion"])(
    "filters %s before accepting assignment completion",
    async (mode) => {
      const { protocol } = fixture(mode);
      const result = await protocol.run();
      expect(result).toMatchObject({
        threadId: "thread-1",
        turnId: "turn-1",
        observedModel: "gpt-5.6-luna",
        observedEffort: "low",
        finalResponse: "Pull request opened.",
        approvalCount: 0,
        reroutes: [],
      });
      expect(result.itemSummaries).toHaveLength(2);
      expect(result.tokenUsage?.total.totalTokens).toBe(19);
    },
  );

  test.each([
    ["reroute", "model_rerouted"],
    ["model-mismatch", "observed_model_mismatch"],
    ["effort-mismatch", "observed_effort_mismatch"],
    ["effort-missing", "observed_effort_missing"],
    ["provider-error", "provider_error_notification"],
    ["early-error", "provider_error_notification"],
  ])("normalizes %s", async (mode, code) => {
    const { protocol } = fixture(mode);
    await expect(protocol.run()).rejects.toMatchObject({ code });
    if (mode === "reroute")
      expect(protocol.snapshot().reroutes).toEqual([
        { fromModel: "gpt-5.6-luna", toModel: "other" },
      ]);
    if (mode === "effort-missing")
      expect(protocol.snapshot().finalResponse).toBe("Pull request opened.");
  });

  test.each([
    ["model-mismatch", "observedModel", "another-model"],
    ["effort-mismatch", "observedEffort", "high"],
  ])("emits %s values before validation fails", async (mode, field, value) => {
    const { protocol, events } = fixture(mode);
    await expect(protocol.run()).rejects.toBeInstanceOf(FactoryError);
    expect(
      events.some(
        ({ patch }) =>
          patch?.[field as "observedModel" | "observedEffort"] === value,
      ),
    ).toBe(true);
  });

  test("retains protocol records through the supplied sink without duplicating them in the outcome", async () => {
    const records: RetainedProviderRecord[] = [];
    const { protocol } = fixture("success", {
      retain: (batch) => {
        records.push(...batch);
      },
    });
    const result = await protocol.run();
    expect(records.map(({ kind }) => kind)).toEqual([
      "item",
      "item",
      "transcript",
      "usage",
    ]);
    expect(result.records).toEqual([]);
  });

  test("stops before persistence when a response is followed by a terminal notification", async () => {
    const { protocol, events } = fixture("response-then-error");
    await expect(protocol.run()).rejects.toMatchObject({
      code: "provider_error_notification",
    });
    expect(events).toEqual([]);
  });

  test("keeps terminal errors authoritative during final persistence and after completion", async () => {
    let settings = 0;
    const { protocol } = fixture("success", {
      emit: async (event, connection) => {
        if (event.type === "provider.settings.observed" && ++settings === 2) {
          await connection.receive({ method: APP_SERVER_METHODS.error });
        }
      },
    });
    await expect(protocol.run()).rejects.toMatchObject({
      code: "provider_error_notification",
    });
    expect(protocol.snapshot().finalResponse).toBe("Pull request opened.");
  });

  test("observes terminal connection failure until the owner disposes the protocol", async () => {
    const { protocol, connection } = fixture();
    await protocol.run();
    connection.fail(
      new FactoryError({
        code: "provider_protocol_error",
        message: "connection failed",
      }),
    );
    expect(() => protocol.throwIfTerminal()).toThrow("connection failed");
  });

  test("uses deterministic waiter timeout without scheduling a timer", async () => {
    const { protocol } = fixture("turn-timeout", {
      emit: async (event, connection) => {
        if (event.type === "provider.turn.started") connection.expireWaiters();
      },
    });
    await expect(protocol.run()).rejects.toMatchObject({
      code: "turn_completion_timeout",
    });
  });

  test("denies permission approval requests with an empty permission grant", async () => {
    const { protocol, connection } = fixture("turn-timeout", {
      emit: async (event, rpc) => {
        if (event.type === "provider.turn.started")
          await rpc.receive({
            id: "permission-1",
            method: APP_SERVER_METHODS.itemRequestApproval,
          });
      },
    });
    await expect(protocol.run()).rejects.toMatchObject({
      code: "approval_requested",
    });
    expect(protocol.snapshot().approvalCount).toBe(1);
    expect(connection.sent.at(-1)).toEqual({
      id: "permission-1",
      result: { permissions: {} },
    });
  });
});
