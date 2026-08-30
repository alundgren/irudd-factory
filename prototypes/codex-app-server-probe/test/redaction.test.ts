import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunArtifacts } from "../src/artifacts.ts";
import { Redactor } from "../src/redaction.ts";
import { DEFAULT_TIMEOUTS, type RunManifest } from "../src/types.ts";

describe("Redactor", () => {
  test("removes an exact secret from nested protocol, stderr, approval, and report values", () => {
    const secret = "probe-secret-123";
    const redactor = new Redactor([secret]);
    const value = redactor.value({
      protocol: { text: `token=${secret}` },
      stderr: secret,
      approval: `run ${secret}`,
      report: `failed with ${secret}`,
    });
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(JSON.stringify(value).match(/\[REDACTED\]/g)?.length).toBe(4);
  });

  test("can add a secret after construction", () => {
    const redactor = new Redactor([]);
    redactor.add("later-secret");
    expect(redactor.text("later-secret")).toBe("[REDACTED]");
  });

  test("never writes a synthetic secret to capture, manifest, or report", async () => {
    const secret = "persisted-secret-must-not-appear";
    const root = await mkdtemp(join(tmpdir(), "probe-artifacts-"));
    const artifacts = new RunArtifacts(root, new Redactor([secret]));
    await artifacts.initialize();
    artifacts.record("server", { protocol: secret });
    artifacts.record("child-stderr", `stderr ${secret}`);
    const now = new Date().toISOString();
    const manifest: RunManifest = {
      runId: "redaction-test",
      scenario: "read",
      campaignRoot: root,
      runRoot: root,
      workspace: root,
      probeManagedPaths: [root],
      sandboxPolicy: { type: "readOnly" },
      remote: null,
      repository: null,
      startingCommit: null,
      requestedModel: "gpt-5.6-luna",
      requestedEffort: "low",
      observedModel: "gpt-5.6-luna",
      observedEffort: "low",
      threadSettings: null,
      reroutes: [],
      codexVersion: "fake",
      schemaDigest: "digest",
      threadId: "thread",
      turnId: "turn",
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      serializedUtf8Bytes: artifacts.serializedBytes(),
      itemLifecycles: [{ output: secret }],
      tokenUsageUpdates: [],
      approvals: [],
      processExit: null,
      result: "assertion_failed",
      effects: { report: secret },
      assertions: [{ name: "redaction", passed: false, detail: secret }],
      timeouts: DEFAULT_TIMEOUTS,
    };
    await artifacts.finish(manifest);
    for (const name of [
      "protocol.redacted.jsonl",
      "manifest.json",
      "report.md",
    ]) {
      expect(await readFile(join(root, name), "utf8")).not.toContain(secret);
    }
  });
});
