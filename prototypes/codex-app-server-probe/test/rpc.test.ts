import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { RunArtifacts } from "../src/artifacts.ts";
import {
  spawnManaged,
  terminateOwnedGroup,
  type ManagedProcess,
} from "../src/process.ts";
import { Redactor } from "../src/redaction.ts";
import { RpcClient } from "../src/rpc.ts";

const fake = join(import.meta.dir, "helpers/fake-app-server.ts");
const children: ManagedProcess[] = [];

async function client(
  mode: string,
  approvalInput?: NodeJS.ReadableStream,
): Promise<{
  client: RpcClient;
  child: ManagedProcess;
  artifacts: RunArtifacts;
}> {
  await chmod(fake, 0o755);
  const root = await mkdtemp(join(tmpdir(), "probe-rpc-"));
  const artifacts = new RunArtifacts(root, new Redactor(["synthetic-secret"]));
  await artifacts.initialize();
  const child = spawnManaged({
    command: [fake, "app-server", "--stdio"],
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_MODE: mode },
  });
  children.push(child);
  const quietOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rpc = new RpcClient(
    child,
    artifacts,
    "read",
    100,
    approvalInput ?? process.stdin,
    quietOutput,
  );
  rpc.start();
  return { client: rpc, child, artifacts };
}

afterEach(async () => {
  await Promise.all(
    children
      .splice(0)
      .map((child) => terminateOwnedGroup(child, 100).catch(() => -1)),
  );
});

describe("JSON-RPC process integration", () => {
  test("tracks requests, streamed events, authoritative items, usage, and unknown messages", async () => {
    const setup = await client("success");
    const methods: string[] = [];
    setup.client.onMessage((message) => {
      if (message.method) methods.push(message.method);
    });
    await setup.client.request("initialize", { clientInfo: {} }, 1_000);
    setup.client.notify("initialized", {});
    const models = await setup.client.request("model/list", {}, 1_000);
    expect(models.data[0].id).toBe("gpt-5.6-luna");
    await setup.client.request("thread/start", {}, 1_000);
    const completed = setup.client.waitFor(
      (message) => message.method === "turn/completed",
      1_000,
      "turn_timeout",
    );
    await setup.client.request("turn/start", {}, 1_000);
    await completed;
    expect(methods).toContain("unknown/futureNotification");
    expect(methods).toContain("item/agentMessage/delta");
    expect(methods).toContain("item/completed");
    expect(methods).toContain("thread/tokenUsage/updated");
  });

  test("maps malformed JSON to protocol_error and fails a pending request", async () => {
    const setup = await client("malformed");
    await setup.client.request("initialize", {}, 1_000);
    await expect(
      setup.client.request("model/list", {}, 1_000),
    ).rejects.toMatchObject({
      result: "protocol_error",
      code: "malformed_json",
    });
  });

  test("maps child exit to provider_exited and fails pending requests", async () => {
    const setup = await client("exit-pending");
    await setup.client.request("initialize", {}, 1_000);
    await setup.client.request("thread/start", {}, 1_000);
    await expect(
      setup.client.request("turn/start", {}, 1_000),
    ).rejects.toMatchObject({
      result: "provider_exited",
    });
  });

  test("preserves model rejection as a JSON-RPC error", async () => {
    const setup = await client("model-rejected");
    await setup.client.request("initialize", {}, 1_000);
    await expect(
      setup.client.request("model/list", {}, 1_000),
    ).rejects.toMatchObject({ code: "rpc_error" });
  });

  test("interrupts only after the named command becomes active and rejects a duplicate", async () => {
    const setup = await client("interrupt");
    await setup.client.request("initialize", {}, 1_000);
    await setup.client.request("thread/start", {}, 1_000);
    const active = setup.client.waitFor(
      (message) =>
        message.method === "item/started" &&
        JSON.stringify(message.params).includes("probe-long-running"),
      1_000,
      "active_timeout",
    );
    await setup.client.request("turn/start", {}, 1_000);
    await active;
    const completed = setup.client.waitFor(
      (message) => message.method === "turn/completed",
      1_000,
      "turn_timeout",
    );
    await setup.client.request(
      "turn/interrupt",
      { threadId: "thread-fake", turnId: "turn-fake" },
      1_000,
    );
    expect((await completed).params?.turn).toMatchObject({
      status: "interrupted",
    });
    await expect(
      setup.client.request(
        "turn/interrupt",
        { threadId: "thread-fake", turnId: "turn-fake" },
        1_000,
      ),
    ).rejects.toMatchObject({ code: "rpc_error" });
  });

  test("bounded cleanup terminates an owned process group", async () => {
    const setup = await client("interrupt");
    const started = Date.now();
    await terminateOwnedGroup(setup.child, 100);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("reports a cleanup timeout when exit never resolves after SIGKILL", async () => {
    const signals: NodeJS.Signals[] = [];
    const never = new Promise<number>(() => undefined);
    const child = {
      process: { pid: 424_242 },
      pid: 424_242,
      exited: never,
    } as ManagedProcess;
    const started = Date.now();
    await expect(
      terminateOwnedGroup(child, 10, (_managed, signal) => {
        signals.push(signal);
      }),
    ).rejects.toMatchObject({
      result: "timed_out",
      code: "cleanup_timeout",
      detail: { lastSignal: "SIGKILL" },
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("records SIGKILL when forced termination succeeds", async () => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const child = {
      process: { pid: 424_243 },
      pid: 424_243,
      exited,
    } as ManagedProcess;
    const termination = await terminateOwnedGroup(
      child,
      10,
      (_managed, signal) => {
        if (signal === "SIGKILL") resolveExit(137);
      },
    );
    expect(termination).toEqual({ code: 137, signal: "SIGKILL" });
  });

  test("interrupt resolves a pending approval without accepting it", async () => {
    const approvalInput = new PassThrough();
    const setup = await client("approval-interrupt", approvalInput);
    await setup.client.request("initialize", {}, 1_000);
    await setup.client.request("thread/start", {}, 1_000);
    const approval = setup.client.waitFor(
      (message) => message.method === "item/commandExecution/requestApproval",
      1_000,
      "approval_timeout",
    );
    await setup.client.request("turn/start", {}, 1_000);
    await approval;
    const completed = setup.client.waitFor(
      (message) => message.method === "turn/completed",
      1_000,
      "turn_timeout",
    );
    await setup.client.request(
      "turn/interrupt",
      { threadId: "thread-fake", turnId: "turn-fake" },
      1_000,
    );
    await completed;
    await Bun.sleep(10);
    expect(setup.client.approvals).toContainEqual(
      expect.objectContaining({
        requestId: 900,
        decision: "cancelled_by_server",
      }),
    );
    approvalInput.destroy();
  });

  test("approval timeout is recorded as a cancellation", async () => {
    const approvalInput = new PassThrough();
    const setup = await client("approval-timeout", approvalInput);
    await setup.client.request("initialize", {}, 1_000);
    await setup.client.request("thread/start", {}, 1_000);
    const completion = setup.client.waitFor(
      (message) => message.method === "turn/completed",
      1_000,
      "turn_timeout",
    );
    await setup.client.request("turn/start", {}, 1_000);
    await expect(completion).rejects.toMatchObject({
      result: "approval_cancelled",
      code: "approval_timeout",
    });
    expect(setup.client.approvals).toContainEqual(
      expect.objectContaining({
        requestId: 900,
        decision: "cancelled:approval_timeout",
      }),
    );
    approvalInput.destroy();
  });
});
