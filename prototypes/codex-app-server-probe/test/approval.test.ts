import { describe, expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promptForApproval } from "../src/approval.ts";
import { RunArtifacts } from "../src/artifacts.ts";
import { Redactor } from "../src/redaction.ts";
import { ProbeError, type RpcMessage } from "../src/types.ts";

async function setup(): Promise<RunArtifacts> {
  const artifacts = new RunArtifacts(
    await mkdtemp(join(tmpdir(), "probe-approval-")),
    new Redactor([]),
  );
  await artifacts.initialize();
  return artifacts;
}

function output(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

const request: RpcMessage = {
  id: 90,
  method: "item/commandExecution/requestApproval",
  params: {
    command: "git status",
    cwd: "/workspace",
    availableDecisions: ["accept", "decline", "cancel"],
  },
};

describe("approval handling", () => {
  test("records an explicit available decision", async () => {
    const outcome = await promptForApproval(
      request,
      "edit",
      1_000,
      await setup(),
      Readable.from(["accept\n"]),
      output(),
    );
    expect(outcome.response).toEqual({ decision: "accept" });
    expect(outcome.record.action).toContain("git status");
  });

  test("EOF never accepts", async () => {
    await expect(
      promptForApproval(
        request,
        "edit",
        1_000,
        await setup(),
        Readable.from([]),
        output(),
      ),
    ).rejects.toMatchObject({
      result: "approval_cancelled",
      code: "approval_eof",
    });
  });

  test("invalid and unavailable input never accepts", async () => {
    await expect(
      promptForApproval(
        request,
        "edit",
        1_000,
        await setup(),
        Readable.from(["always\n"]),
        output(),
      ),
    ).rejects.toBeInstanceOf(ProbeError);
  });

  test("timeout cancels", async () => {
    const pending = new Readable({ read() {} });
    await expect(
      promptForApproval(request, "edit", 5, await setup(), pending, output()),
    ).rejects.toMatchObject({
      code: "approval_timeout",
    });
    pending.destroy();
  });

  test("Ctrl-C cancels", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    setTimeout(() => input.write("\u0003"), 5);
    await expect(
      promptForApproval(request, "edit", 1_000, await setup(), input, output()),
    ).rejects.toMatchObject({ code: "approval_interrupted" });
    input.destroy();
  });

  test("network acceptance is limited to pr", async () => {
    const network: RpcMessage = {
      ...request,
      params: {
        networkApprovalContext: {
          host: "github.com",
          protocol: "https",
          port: 443,
        },
        availableDecisions: ["accept", "cancel"],
      },
    };
    await expect(
      promptForApproval(
        network,
        "edit",
        1_000,
        await setup(),
        Readable.from(["accept\n"]),
        output(),
      ),
    ).rejects.toMatchObject({ code: "network_approval_forbidden" });
    const accepted = await promptForApproval(
      network,
      "pr",
      1_000,
      await setup(),
      Readable.from(["accept\n"]),
      output(),
    );
    expect(accepted.record.destination).toEqual({
      host: "github.com",
      protocol: "https",
      port: 443,
    });
  });

  test("rejects destination-free network permissions and paths outside scenario roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-scope-"));
    const scope = {
      workspace: root,
      readableRoots: [root],
      writableRoots: [root],
    };
    const permissions: RpcMessage = {
      id: 91,
      method: "item/permissions/requestApproval",
      params: {
        cwd: root,
        permissions: { network: { enabled: true } },
      },
    };
    await expect(
      promptForApproval(
        permissions,
        "pr",
        1_000,
        await setup(),
        Readable.from(["accept\n"]),
        output(),
        undefined,
        scope,
      ),
    ).rejects.toMatchObject({ code: "destination_free_network_forbidden" });

    const fileChange: RpcMessage = {
      id: 92,
      method: "item/fileChange/requestApproval",
      params: { grantRoot: "/outside" },
    };
    await expect(
      promptForApproval(
        fileChange,
        "edit",
        1_000,
        await setup(),
        Readable.from(["accept\n"]),
        output(),
        undefined,
        scope,
      ),
    ).rejects.toMatchObject({ code: "approval_path_outside_roots" });
  });
});
