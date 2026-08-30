#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const args = Bun.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli fake-1.0.0");
  process.exit(0);
}

if (args[0] === "app-server" && args[1] === "generate-json-schema") {
  const outIndex = args.indexOf("--out");
  const root = args[outIndex + 1];
  if (!root) process.exit(2);
  const names = [
    "v1/InitializeParams.json",
    "v2/ThreadStartParams.json",
    "v2/ThreadStartedNotification.json",
    "v2/TurnStartParams.json",
    "v2/TurnCompletedNotification.json",
    "v2/TurnInterruptParams.json",
    "v2/ItemStartedNotification.json",
    "v2/ItemCompletedNotification.json",
    "CommandExecutionRequestApprovalParams.json",
    "FileChangeRequestApprovalParams.json",
    "PermissionsRequestApprovalParams.json",
    "v2/ServerRequestResolvedNotification.json",
    "v2/ThreadTokenUsageUpdatedNotification.json",
    "v2/ErrorNotification.json",
    "v2/ModelReroutedNotification.json",
  ];
  for (const name of names) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        title: name,
        ...(name === "v2/TurnStartParams.json"
          ? {
              type: "object",
              properties: {
                sandboxPolicy: {
                  anyOf: [
                    { $ref: "#/definitions/SandboxPolicy" },
                    { type: "null" },
                  ],
                },
              },
              definitions: {
                SandboxPolicy: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        type: { enum: ["readOnly"] },
                        networkAccess: { type: "boolean" },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        type: { enum: ["workspaceWrite"] },
                        writableRoots: { type: "array" },
                        networkAccess: { type: "boolean" },
                        excludeSlashTmp: { type: "boolean" },
                        excludeTmpdirEnvVar: { type: "boolean" },
                      },
                    },
                  ],
                },
              },
            }
          : {}),
      }),
    );
  }
  process.exit(0);
}

const executableName = basename(Bun.argv[1] ?? "");
const mode =
  process.env.FAKE_MODE ??
  (executableName.includes("unsupported-effort")
    ? "unsupported-effort"
    : executableName.includes("stale-effort")
      ? "stale-effort"
      : executableName.includes("settings-mismatch")
        ? "settings-mismatch"
        : executableName.includes("model-rejected")
          ? "model-rejected"
          : executableName.includes("rerouted-hang")
            ? "rerouted-hang"
            : executableName.includes("no-activation")
              ? "no-activation"
              : process.cwd().includes("-fail") ||
                  process.cwd().includes("-interrupt")
                ? "interrupt"
                : process.cwd().includes("-edit")
                  ? "edit"
                  : "success");
const reader = createInterface({ input: process.stdin });
let interruptCount = 0;
const validateScenarioPolicy = process.cwd().includes("probe-campaign-");

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

for await (const line of reader) {
  if (!line.trim()) continue;
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: any;
  };
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "model/list") {
    if (mode === "malformed") {
      process.stdout.write("{not-json}\n");
      continue;
    }
    if (mode === "model-rejected") {
      send({
        id: message.id,
        error: { code: -32000, message: "model rejected" },
      });
    } else {
      send({
        id: message.id,
        result: {
          data: [
            {
              id: "gpt-5.6-luna",
              model: "gpt-5.6-luna",
              supportedReasoningEfforts:
                mode === "unsupported-effort"
                  ? [{ reasoningEffort: "medium" }]
                  : [{ reasoningEffort: "low" }],
            },
          ],
        },
      });
    }
  } else if (message.method === "thread/start") {
    if (
      (validateScenarioPolicy && message.params?.approvalPolicy !== "never") ||
      (validateScenarioPolicy &&
        !["read-only", "workspace-write"].includes(message.params?.sandbox))
    ) {
      send({
        id: message.id,
        error: { code: -32602, message: "invalid thread policy" },
      });
      continue;
    }
    send({
      id: message.id,
      result: {
        thread: { id: "thread-fake" },
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        reasoningEffort: mode === "stale-effort" ? "high" : "low",
        cwd: process.cwd(),
      },
    });
  } else if (message.method === "turn/start") {
    const sandboxPolicy = message.params?.sandboxPolicy;
    const validSandbox =
      sandboxPolicy?.type === "readOnly"
        ? sandboxPolicy?.networkAccess === false &&
          sandboxPolicy?.writableRoots === undefined
        : sandboxPolicy?.type === "workspaceWrite" &&
          JSON.stringify(sandboxPolicy?.writableRoots) ===
            JSON.stringify([process.cwd(), join(process.cwd(), ".git")]) &&
          sandboxPolicy?.networkAccess === false &&
          sandboxPolicy?.excludeSlashTmp === true &&
          sandboxPolicy?.excludeTmpdirEnvVar === true;
    if (
      validateScenarioPolicy &&
      (message.params?.approvalPolicy !== "never" || !validSandbox)
    ) {
      send({
        id: message.id,
        error: { code: -32602, message: "invalid turn policy" },
      });
      continue;
    }
    if (mode === "exit-pending") {
      process.exit(7);
    }
    send({
      id: message.id,
      result: { turn: { id: "turn-fake", status: "inProgress" } },
    });
    send({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-fake",
        threadSettings: {
          model: mode === "settings-mismatch" ? "gpt-5.6-sol" : "gpt-5.6-luna",
          modelProvider: "openai",
          effort: mode === "stale-effort" ? "high" : "low",
          cwd: process.cwd(),
        },
      },
    });
    if (mode === "rerouted" || mode === "rerouted-hang") {
      send({
        method: "model/rerouted",
        params: {
          threadId: "thread-fake",
          turnId: "turn-fake",
          fromModel: "gpt-5.6-luna",
          toModel: "other",
        },
      });
      if (mode === "rerouted") {
        send({
          method: "turn/completed",
          params: {
            turn: { id: "turn-fake", status: "completed", model: "other" },
          },
        });
      }
    } else if (
      mode === "interrupt" ||
      mode === "approval-interrupt" ||
      mode === "approval-timeout"
    ) {
      send({
        method: "item/started",
        params: {
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "bun run probe-long-running",
          },
        },
      });
      if (mode === "approval-interrupt" || mode === "approval-timeout") {
        send({
          id: 900,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-fake",
            turnId: "turn-fake",
            itemId: "command-1",
            command: "bun run probe-long-running",
            cwd: process.cwd(),
            availableDecisions: ["accept", "decline", "cancel"],
          },
        });
      }
    } else if (mode !== "no-activation") {
      if (mode === "edit") {
        await writeFile(
          join(process.cwd(), "src", "greet.ts"),
          'export function greeting(): string {\n  return "Hello, Codex probe!";\n}\n',
        );
        await writeFile(
          join(process.cwd(), "test", "greet.test.ts"),
          'import { expect, test } from "bun:test";\nimport { greeting } from "../src/greet.ts";\n\ntest("returns the fixture greeting", () => {\n  expect(greeting()).toBe("Hello, Codex probe!");\n});\n',
        );
      }
      send({
        method: "unknown/futureNotification",
        params: { accepted: true },
      });
      send({
        method: "item/agentMessage/delta",
        params: { itemId: "agent-1", delta: "# Codex" },
      });
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-fake",
          tokenUsage: { total: { totalTokens: 12 } },
        },
      });
      send({
        method: "item/completed",
        params: {
          item: {
            id: "agent-1",
            type: "agentMessage",
            text: "# Codex App Server Probe Fixture",
          },
        },
      });
      send({
        method: "rawResponse/completed",
        params: { response: { model: "gpt-5.6-luna" } },
      });
      send({
        method: "turn/completed",
        params: {
          turn: { id: "turn-fake", status: "completed", model: "gpt-5.6-luna" },
        },
      });
    }
  } else if (message.method === "turn/interrupt") {
    interruptCount += 1;
    if (interruptCount > 1) {
      send({
        id: message.id,
        error: { code: -32602, message: "turn already interrupted" },
      });
      continue;
    }
    send({ id: message.id, result: {} });
    if (mode === "approval-interrupt") {
      send({
        method: "serverRequest/resolved",
        params: { threadId: "thread-fake", requestId: 900 },
      });
    }
    send({
      method: "turn/completed",
      params: {
        turn: { id: "turn-fake", status: "interrupted", model: "gpt-5.6-luna" },
      },
    });
  }
}
