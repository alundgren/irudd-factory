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

async function handle(line: string): Promise<void> {
  const message = JSON.parse(line) as {
    id?: number | string;
    method?: string;
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
      thread: { id: "thread-1" },
      model: mode === "model-mismatch" ? "another-model" : "gpt-5.6-luna",
      ...(mode === "effort-missing"
        ? {}
        : {
            reasoningEffort: mode === "effort-mismatch" ? "high" : "low",
          }),
    });
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    respond(message.id, { turn: { id: "turn-1" } });
    send({
      method: "thread/settings/updated",
      params: {
        threadSettings: {
          model: "gpt-5.6-luna",
          ...(mode === "effort-missing" ? {} : { effort: "low" }),
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
    return;
  }
  if (message.method === "turn/interrupt" && message.id !== undefined) {
    respond(message.id, {});
  }
}

const reader = Bun.stdin
  .stream()
  .pipeThrough(new TextDecoderStream())
  .getReader();
let buffered = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffered += value;
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line) await handle(line);
    newline = buffered.indexOf("\n");
  }
}
