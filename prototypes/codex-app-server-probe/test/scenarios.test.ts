import { describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXPECTED_MODEL, parseArgs } from "../src/config.ts";
import { runScenario, scenarioInternals } from "../src/scenarios.ts";

const fixture = join(import.meta.dir, "..", "fixture");
const fakeCodex = join(import.meta.dir, "helpers", "fake-app-server.ts");

async function git(argv: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(["git", ...argv], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(await new Response(child.stderr).text());
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "probe-assertion-"));
  await cp(fixture, root, { recursive: true });
  await git(["init", "-q", "-b", "main"], root);
  await git(["config", "user.name", "Probe"], root);
  await git(["config", "user.email", "probe@example.invalid"], root);
  await git(["add", "."], root);
  await git(["commit", "-q", "-m", "seed"], root);
  return root;
}

async function runFakeScenario(
  scenario: "read" | "edit" | "fail" | "interrupt",
  fakeName = "fake-app-server",
  extraArgs: string[] = [],
) {
  const campaign = await mkdtemp(join(tmpdir(), "probe-campaign-"));
  const codexHome = join(campaign, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await Bun.write(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "synthetic-provider-token" } }),
  );
  const executable = join(campaign, fakeName);
  await cp(fakeCodex, executable);
  await chmod(executable, 0o755);
  const options = parseArgs(
    [scenario, "--campaign", campaign, "--codex", executable, ...extraArgs],
    process.cwd(),
  );
  return runScenario(options);
}

describe("scenario policies and assertions", () => {
  test("requires the exact model and low effort", () => {
    expect(
      scenarioInternals.modelSupportsLow({
        data: [
          {
            id: EXPECTED_MODEL,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          },
        ],
      }),
    ).toBe(true);
    expect(
      scenarioInternals.modelSupportsLow({
        data: [
          {
            id: EXPECTED_MODEL,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      scenarioInternals.modelSupportsLow({
        data: [
          {
            id: "replacement-model",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          },
        ],
      }),
    ).toBe(false);
  });

  test("uses unrestricted reads and scenario-only writable roots", async () => {
    const root = await workspace();
    const read = scenarioInternals.sandboxFor("read", root) as any;
    const edit = scenarioInternals.sandboxFor("edit", root) as any;
    expect(read).toEqual({ type: "readOnly", networkAccess: false });
    expect(edit).toEqual({
      type: "workspaceWrite",
      writableRoots: [root],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    });
  });

  test("read requires an exact heading and a clean workspace", async () => {
    const root = await workspace();
    const start = await Bun.$`git -C ${root} rev-parse HEAD`.text();
    const passing = await scenarioInternals.assertionsFor(
      "read",
      root,
      ["# Codex App Server Probe Fixture"],
      start.trim(),
    );
    expect(passing.assertions.every((record) => record.passed)).toBe(true);
    const failing = await scenarioInternals.assertionsFor(
      "read",
      root,
      ["wrong"],
      start.trim(),
    );
    expect(failing.assertions.some((record) => !record.passed)).toBe(true);
  });

  test("edit accepts only the specified change and passing external tests", async () => {
    const root = await workspace();
    await Bun.write(
      join(root, "src/greet.ts"),
      'export function greeting(): string {\n  return "Hello, Codex probe!";\n}\n',
    );
    await Bun.write(
      join(root, "test/greet.test.ts"),
      'import { expect, test } from "bun:test";\nimport { greeting } from "../src/greet.ts";\n\ntest("returns the fixture greeting", () => {\n  expect(greeting()).toBe("Hello, Codex probe!");\n});\n',
    );
    const start = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    const checked = await scenarioInternals.assertionsFor(
      "edit",
      root,
      [],
      start,
    );
    expect(checked.assertions.every((record) => record.passed)).toBe(true);
    await Bun.write(join(root, "extra.txt"), "not allowed\n");
    const rejected = await scenarioInternals.assertionsFor(
      "edit",
      root,
      [],
      start,
    );
    expect(
      rejected.assertions.find(
        (record) => record.name === "exact_allowed_files",
      )?.passed,
    ).toBe(false);
  });

  test("detects the deterministic long-running command and ignores other commands", () => {
    expect(
      scenarioInternals.longCommandActive({
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            command: ["bun", "run", "probe-long-running"],
          },
        },
      }),
    ).toBe(true);
    expect(
      scenarioInternals.longCommandActive({
        method: "item/started",
        params: {
          item: { type: "commandExecution", command: ["bun", "test"] },
        },
      }),
    ).toBe(false);
  });

  test("rejects PR effects for the wrong remote and missing target pull request", async () => {
    const root = await workspace();
    await git(
      ["remote", "add", "origin", "https://github.com/example/wrong.git"],
      root,
    );
    await git(["checkout", "-q", "-b", "codex-probe/test"], root);
    const start = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    const checked = await scenarioInternals.assertionsFor(
      "pr",
      root,
      [],
      start,
    );
    expect(
      checked.assertions.find((record) => record.name === "target_remote")
        ?.passed,
    ).toBe(false);
    expect(
      checked.assertions.find((record) => record.name === "target_pull_request")
        ?.passed,
    ).toBe(false);
  });

  test("requires open PR evidence at the exact remote commit and default branch", () => {
    const input = {
      branch: "codex-probe/run-1",
      expectedBranch: "codex-probe/run-1",
      commit: "abc123",
      startingCommit: "base123",
      remoteBaseOid: "base123",
      expectedDefaultBranch: "main",
      remoteOid: "abc123",
      defaultBranch: "main",
      prCode: 0,
      prDetails: {
        state: "OPEN",
        headRefName: "codex-probe/run-1",
        headRefOid: "abc123",
        baseRefName: "main",
        url: "https://github.com/alundgren/irudd-factory-agent-testing/pull/7",
      },
    };
    expect(scenarioInternals.evaluatePrEvidence(input)).toBe(true);
    expect(
      scenarioInternals.evaluatePrEvidence({
        ...input,
        remoteOid: "older-commit",
      }),
    ).toBe(false);
    expect(
      scenarioInternals.evaluatePrEvidence({
        ...input,
        remoteBaseOid: "other-base",
      }),
    ).toBe(false);
    expect(
      scenarioInternals.evaluatePrEvidence({
        ...input,
        prDetails: { ...input.prDetails, state: "CLOSED" },
      }),
    ).toBe(false);
  });

  test("base-to-head file checks include changes committed before the run", async () => {
    const root = await workspace();
    const base = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    await Bun.write(join(root, "preexisting.txt"), "must be detected\n");
    await git(["add", "preexisting.txt"], root);
    await git(["commit", "-q", "-m", "preexisting source change"], root);
    await Bun.write(join(root, "src/greet.ts"), "task change\n");
    await git(["add", "src/greet.ts"], root);
    await git(["commit", "-q", "-m", "task change"], root);
    const head = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    expect(
      await scenarioInternals.committedFilesFromBase(root, base, head),
    ).toEqual(["preexisting.txt", "src/greet.ts"]);
  });

  test("PR file, commit, branch, and external test assertions pass only for the exact task", async () => {
    const root = await workspace();
    await git(
      [
        "remote",
        "add",
        "origin",
        "https://github.com/alundgren/irudd-factory-agent-testing.git",
      ],
      root,
    );
    const expectedBranch = "codex-probe/exact-run";
    await git(["checkout", "-q", "-b", expectedBranch], root);
    const start = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    await Bun.write(
      join(root, "src/greet.ts"),
      'export function greeting(): string {\n  return "Hello from the PR probe!";\n}\n',
    );
    await Bun.write(
      join(root, "test/greet.test.ts"),
      'import { expect, test } from "bun:test";\nimport { greeting } from "../src/greet.ts";\n\ntest("returns the fixture greeting", () => {\n  expect(greeting()).toBe("Hello from the PR probe!");\n});\n',
    );
    await git(["add", "src/greet.ts", "test/greet.test.ts"], root);
    await git(["commit", "-q", "-m", "Apply exact PR probe task"], root);
    const checked = await scenarioInternals.assertionsFor(
      "pr",
      root,
      [],
      start,
      expectedBranch,
    );
    for (const name of [
      "target_remote",
      "exact_run_branch",
      "new_commit",
      "clean_after_pr",
      "exact_pr_files",
      "exact_pr_change",
      "pr_fixture_tests_pass",
    ]) {
      expect(
        checked.assertions.find((record) => record.name === name)?.passed,
      ).toBe(true);
    }
    expect(
      checked.assertions.find((record) => record.name === "target_pull_request")
        ?.passed,
    ).toBe(false);
  });

  test("runs the complete read scenario against the fake executable without a Codex turn", async () => {
    const outcome = await runFakeScenario("read");
    expect(outcome.result).toBe("completed");
    const manifest = await Bun.file(
      join(outcome.runRoot, "manifest.json"),
    ).json();
    expect(manifest.result).toBe("completed");
    expect(manifest.requestedModel).toBe("gpt-5.6-luna");
    expect(
      manifest.assertions.every((record: { passed: boolean }) => record.passed),
    ).toBe(true);
  });

  test("runs complete edit, fail, and interrupt fake scenarios", async () => {
    expect((await runFakeScenario("edit")).result).toBe("completed");
    const failed = await runFakeScenario("fail");
    expect(failed.result).toBe("provider_exited");
    const failManifest = await Bun.file(
      join(failed.runRoot, "manifest.json"),
    ).json();
    expect(failManifest.effects.status).toBe("");
    expect(failManifest.assertions).toContainEqual({
      name: "workspace_has_no_diff",
      passed: true,
      detail: "clean",
    });
    expect(failManifest.assertions).not.toContainEqual(
      expect.objectContaining({ name: "provider_exited", passed: false }),
    );
    expect((await runFakeScenario("interrupt")).result).toBe("interrupted");
  });

  test("returns model_unavailable for unsupported effort", async () => {
    const outcome = await runFakeScenario("read", "codex-unsupported-effort");
    expect(outcome.result).toBe("model_unavailable");
  });

  test("returns model_unavailable when model discovery is rejected", async () => {
    const outcome = await runFakeScenario("read", "codex-model-rejected");
    expect(outcome.result).toBe("model_unavailable");
  });

  test("a reroute wins even when the provider never completes", async () => {
    const outcome = await runFakeScenario("read", "codex-rerouted-hang", [
      "--turnMs",
      "1000",
    ]);
    expect(outcome.result).toBe("model_rerouted");
  });

  test("does not interrupt before activation and cleans up on timeout", async () => {
    const outcome = await runFakeScenario("interrupt", "codex-no-activation", [
      "--activeEventMs",
      "25",
      "--shutdownMs",
      "100",
    ]);
    expect(outcome.result).toBe("timed_out");
    const capture = await Bun.file(
      join(outcome.runRoot, "protocol.redacted.jsonl"),
    ).text();
    const clientMethods = capture
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.direction === "client")
      .map((entry) => entry.message.method);
    expect(clientMethods).not.toContain("turn/interrupt");
  });

  test("fail and interrupt assertions reject workspace changes", async () => {
    const root = await workspace();
    await Bun.write(join(root, "unexpected.txt"), "change\n");
    const start = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
    for (const scenario of ["fail", "interrupt"] as const) {
      const checked = await scenarioInternals.assertionsFor(
        scenario,
        root,
        [],
        start,
      );
      expect(checked.assertions.every((record) => record.passed)).toBe(false);
    }
  });
});
