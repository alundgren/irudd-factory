import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const mode = process.argv[2] ?? "success";
const args = process.argv.slice(3);

if (args.includes("--version")) {
  if (mode === "version-failure") {
    console.error("sensitive stderr must not be stored");
    process.exit(9);
  }
  console.log("codex-cli fake-1.0.0");
  process.exit(0);
}

if (args.includes("generate-json-schema")) {
  if (mode === "schema-failure") {
    console.error("sensitive schema stderr must not be stored");
    process.exit(8);
  }
  const outIndex = args.indexOf("--out");
  const root = args[outIndex + 1];
  if (!root) process.exit(2);
  await mkdir(root, { recursive: true });
  for (const name of [
    "InitializeParams",
    "ThreadStartParams",
    "TurnStartParams",
    "TurnCompletedNotification",
    "TurnInterruptParams",
    "ItemStartedNotification",
    "ItemCompletedNotification",
    "ThreadTokenUsageUpdatedNotification",
    "ModelReroutedNotification",
  ]) {
    await writeFile(join(root, `${name}.json`), "{}\n");
  }
  process.exit(0);
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id: number | string, result: unknown): void {
  send({ id, result });
}

// Ambient default if no effort is requested
const CONFIGURED_EFFORT = "high";

function requestedEffort(params: Record<string, unknown> | undefined): string {
  const config = params?.config as Record<string, unknown> | undefined;
  const effort = config?.model_reasoning_effort;
  return typeof effort === "string" ? effort : CONFIGURED_EFFORT;
}

async function handle(line: string): Promise<void> {
  const message = JSON.parse(line) as {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (message.method === "initialize") {
    if (mode === "malformed") {
      process.stdout.write("not-json\n");
      return;
    }
    if (mode !== "initialization-timeout" && message.id !== undefined) {
      respond(message.id, { userAgent: "fake" });
    }
    return;
  }
  if (message.method === "model/list" && message.id !== undefined) {
    if (mode === "model-timeout") return;
    if (mode === "early-error") {
      send({ method: "error", params: { message: "early provider failure" } });
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
    if (mode === "thread-timeout") return;
    const response = {
      id: message.id,
      result: {
        thread: { id: "thread-1" },
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
      process.stdout.write(
        `${JSON.stringify(response)}\n${JSON.stringify(error)}\n`,
      );
    } else {
      send(response);
    }
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    respond(message.id, { turn: { id: "turn-1" } });
    send({
      method: "thread/settings/updated",
      params: {
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
    if (mode === "provider-exit") process.exit(2);
    send({
      method: "item/started",
      params: { item: { id: "item-1", type: "agentMessage" } },
    });
    send({
      method: "item/completed",
      params: {
        item: {
          id: "item-1",
          type: "agentMessage",
          status: "completed",
          text: "Pull request opened.",
        },
      },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
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
    send({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    });
    if (mode.startsWith("post-completion-")) {
      await delay(25);
      if (mode === "post-completion-error") {
        send({ method: "error", params: { message: "late provider failure" } });
      }
      if (mode === "post-completion-malformed") {
        process.stdout.write("not-json\n");
      }
      if (mode === "post-completion-exit") process.exit(2);
    }
    return;
  }
  if (message.method === "turn/interrupt" && message.id !== undefined) {
    if (mode !== "interrupt-timeout") respond(message.id, {});
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim()) await handle(line.trim());
}
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
