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

const ASSIGNMENT_THREAD_ID = "thread-1";
const ASSIGNMENT_TURN_ID = "turn-1";
async function handle(line: string): Promise<void> {
  const message = JSON.parse(line) as {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (message.id === "approval-1" && !message.method) {
    await writeFile(
      join(process.cwd(), "approval-response.json"),
      JSON.stringify(message),
    );
    return;
  }
  if (message.method === "initialize") {
    if (mode === "fragmented" && message.id !== undefined) {
      const line = JSON.stringify({
        id: message.id,
        result: { userAgent: "fake" },
      });
      process.stdout.write(line.slice(0, 5));
      await delay(10);
      process.stdout.write(`${line.slice(5)}\n`);
      return;
    }
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
    respond(message.id, {
      thread: { id: ASSIGNMENT_THREAD_ID },
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
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
          effort: message.params?.effort,
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
    if (mode === "turn-timeout") return;
    if (mode === "provider-exit") process.exit(2);
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
    {
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
    if (mode === "retention-pause") return;
    send({
      method: "turn/completed",
      params: {
        threadId: ASSIGNMENT_THREAD_ID,
        turn: { id: ASSIGNMENT_TURN_ID, status: "completed" },
      },
    });
    if (mode.startsWith("post-completion-")) {
      await delay(25);
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
