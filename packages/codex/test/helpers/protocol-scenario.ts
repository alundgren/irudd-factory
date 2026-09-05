import type { RpcMessage } from "../../src/connection.ts";

export function protocolScenario(
  mode: string,
  send: (message: RpcMessage) => void,
) {
  const respond = (id: number | string, result: unknown) =>
    send({ id, result });
  // Ambient default if no effort is requested
  const CONFIGURED_EFFORT = "high";

  const ASSIGNMENT_THREAD_ID = "thread-1";
  const ASSIGNMENT_TURN_ID = "turn-1";
  // A subagent the assignment thread spawns reports over the same connection.
  const SUBAGENT_THREAD_ID = "thread-2";
  const SUBAGENT_TURN_ID = "turn-2";

  function requestedEffort(
    params: Record<string, unknown> | undefined,
  ): string {
    const config = params?.config as Record<string, unknown> | undefined;
    const effort = config?.model_reasoning_effort;
    return typeof effort === "string" ? effort : CONFIGURED_EFFORT;
  }

  /**
   * Everything a subagent thread reports before the assignment thread finishes:
   * its own settings, its own final message, and its own completed turn.
   */
  function sendSubagentTurn(): void {
    for (const method of [
      "model/rerouted",
      "error",
      "thread/tokenUsage/updated",
    ]) {
      send({ method, params: { threadId: SUBAGENT_THREAD_ID } });
    }
    send({
      method: "thread/settings/updated",
      params: {
        threadId: SUBAGENT_THREAD_ID,
        threadSettings: { model: "gpt-5.6-sol", effort: "high" },
      },
    });
    send({
      method: "item/started",
      params: {
        threadId: SUBAGENT_THREAD_ID,
        turnId: SUBAGENT_TURN_ID,
        item: { id: "item-sub", type: "agentMessage" },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: SUBAGENT_THREAD_ID,
        turnId: SUBAGENT_TURN_ID,
        item: {
          id: "item-sub",
          type: "agentMessage",
          status: "completed",
          text: "Review: Plan - Pass",
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: SUBAGENT_THREAD_ID,
        turn: { id: SUBAGENT_TURN_ID, status: "completed" },
      },
    });
  }

  async function handle(message: RpcMessage): Promise<void> {
    if (message.method === "initialize") {
      if (message.id !== undefined) {
        respond(message.id, { userAgent: "fake" });
      }
      return;
    }
    if (message.method === "model/list" && message.id !== undefined) {
      if (mode === "early-error") {
        send({
          method: "error",
          params: { message: "early provider failure" },
        });
        return;
      }
      respond(message.id, {
        data: [
          {
            id: "gpt-5.6-luna",
            supportedReasoningEfforts: ["low"],
          },
        ],
      });
      return;
    }
    if (message.method === "thread/start" && message.id !== undefined) {
      const response = {
        id: message.id,
        result: {
          thread: { id: ASSIGNMENT_THREAD_ID },
          model: mode === "model-mismatch" ? "another-model" : "gpt-5.6-luna",
          ...(mode === "effort-missing"
            ? {}
            : {
                reasoningEffort:
                  mode === "effort-mismatch"
                    ? CONFIGURED_EFFORT
                    : requestedEffort(message.params),
              }),
        },
      };
      if (mode === "response-then-error") {
        const error = { method: "error", params: { message: "thread failed" } };
        send(response);
        send(error);
      } else {
        send(response);
      }
      return;
    }
    if (message.method === "turn/start" && message.id !== undefined) {
      respond(message.id, { turn: { id: ASSIGNMENT_TURN_ID } });
      send({
        method: "thread/settings/updated",
        params: {
          threadId: ASSIGNMENT_THREAD_ID,
          threadSettings: {
            model: "gpt-5.6-luna",
            ...(mode === "effort-missing"
              ? {}
              : { effort: message.params?.effort }),
          },
        },
      });
      if (mode === "approval") {
        send({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {},
        });
        return;
      }
      if (mode === "reroute") {
        send({
          method: "model/rerouted",
          params: { fromModel: "gpt-5.6-luna", toModel: "other" },
        });
        return;
      }
      if (mode === "turn-timeout") return;
      if (mode === "provider-error") {
        send({ method: "error", params: { message: "provider failed" } });
        return;
      }

      if (mode === "subagent-noise") sendSubagentTurn();
      if (mode === "subagent-early-completion") {
        send({
          method: "turn/completed",
          params: {
            threadId: SUBAGENT_THREAD_ID,
            turn: { id: SUBAGENT_TURN_ID, status: "completed" },
          },
        });
      }
      send({
        method: "item/started",
        params: {
          threadId: ASSIGNMENT_THREAD_ID,
          turnId: ASSIGNMENT_TURN_ID,
          item: { id: "item-1", type: "agentMessage" },
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId: ASSIGNMENT_THREAD_ID,
          turnId: ASSIGNMENT_TURN_ID,
          item: {
            id: "item-1",
            type: "agentMessage",
            status: "completed",
            text: "Pull request opened.",
          },
        },
      });
      if (mode !== "no-usage") {
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: ASSIGNMENT_THREAD_ID,
            turnId: ASSIGNMENT_TURN_ID,
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
          },
        });
      }
      send({
        method: "turn/completed",
        params: {
          threadId: ASSIGNMENT_THREAD_ID,
          turn: { id: ASSIGNMENT_TURN_ID, status: "completed" },
        },
      });

      return;
    }
  }

  return handle;
}
