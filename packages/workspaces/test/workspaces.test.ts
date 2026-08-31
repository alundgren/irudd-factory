import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  assertPathWithin,
  makeWorkspaceService,
  type GitRunner,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("workspace adapter", () => {
  test("rejects lexical path escapes", () => {
    expect(() =>
      assertPathWithin("/factory", "/factory/work", "path"),
    ).not.toThrow();
    expect(() =>
      assertPathWithin("/factory", "/factory-other", "path"),
    ).toThrow("outside its application-owned root");
  });

  test("creates a retained linked worktree at the stored commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-workspace-test-"));
    roots.push(root);
    const assignmentId = "assignment-1";
    const clone = join(root, "clones", "owner--repository");
    const worktree = join(root, "worktrees", assignmentId);
    const worktreeGit = join(clone, ".git", "worktrees", assignmentId);
    const commonGit = join(clone, ".git");
    const calls: Array<{ args: ReadonlyArray<string>; cwd?: string }> = [];
    const runner: GitRunner = {
      run: async (args, cwd) => {
        calls.push({ args, ...(cwd ? { cwd } : {}) });
        if (args[1] === "clone") await mkdir(commonGit, { recursive: true });
        if (args[1] === "worktree") {
          await Promise.all([
            mkdir(worktree, { recursive: true }),
            mkdir(worktreeGit, { recursive: true }),
          ]);
        }
        if (args.includes("--absolute-git-dir")) {
          return { stdout: `${worktreeGit}\n`, stderr: "", exitCode: 0 };
        }
        if (args.includes("--git-common-dir")) {
          return { stdout: `${commonGit}\n`, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const paths = await Effect.runPromise(
      makeWorkspaceService({ root, runner }).create({
        repository: "owner/repository",
        assignmentId,
        startingCommit: "a".repeat(40),
      }),
    );
    expect(paths.branch).toBe("factory/assignment-1");
    expect(paths.clonePath).toBe(clone);
    expect(paths.worktreePath).toBe(worktree);
    expect(paths.worktreeGitDir).toBe(worktreeGit);
    expect(paths.commonGitDir).toBe(commonGit);
    const add = calls.find(({ args }) => args[1] === "worktree");
    expect(add?.args).toContain("a".repeat(40));
    expect(calls.every(({ args }) => Array.isArray(args))).toBe(true);
  });

  test("refuses to reuse a clone with another remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-workspace-test-"));
    roots.push(root);
    await mkdir(join(root, "clones", "owner--repository"), {
      recursive: true,
    });
    const runner: GitRunner = {
      run: async () => ({
        stdout: "https://github.com/someone/else.git\n",
        stderr: "",
        exitCode: 0,
      }),
    };
    const result = await Effect.runPromiseExit(
      makeWorkspaceService({ root, runner }).create({
        repository: "owner/repository",
        assignmentId: "assignment-1",
        startingCommit: "a".repeat(40),
      }),
    );
    expect(result._tag).toBe("Failure");
  });
});
