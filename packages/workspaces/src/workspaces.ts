import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { WorkspaceService } from "@irudd-factory/application";
import {
  FactoryError,
  REPOSITORY_NAME_PATTERN,
  Workspaces,
} from "@irudd-factory/application";
import { Effect, Layer } from "effect";

/** The Git executable every workspace command runs through. */
const GIT_CLI = "git";

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitRunner {
  readonly run: (
    args: ReadonlyArray<string>,
    cwd?: string,
  ) => Promise<GitResult>;
}

export const nodeGitRunner: GitRunner = {
  run: async (args, cwd) => {
    if (args.length === 0 || args.some((part) => part.includes("\0"))) {
      throw new FactoryError({
        code: "git_command_invalid",
        message: "Git command must be a nonempty argument array",
      });
    }
    const [executable, ...commandArgs] = args;
    if (!executable) {
      throw new FactoryError({
        code: "git_command_invalid",
        message: "Git command must be a nonempty argument array",
      });
    }
    const child = spawn(executable, commandArgs, {
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      exitCodeFor(child),
    ]);
    return { stdout, stderr, exitCode };
  },
};

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) output += String(chunk);
  return output;
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        new FactoryError({
          code: "git_command_failed",
          message: `Git command failed to start: ${error.message}`,
        }),
      ),
    );
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export function assertPathWithin(
  root: string,
  target: string,
  description: string,
): void {
  const relation = relative(root, target);
  if (
    relation === "" ||
    (!relation.startsWith("..") && !isAbsolute(relation))
  ) {
    return;
  }
  throw new FactoryError({
    code: "workspace_path_escape",
    message: `${description} is outside its application-owned root`,
    detail: target,
  });
}

async function checked(
  runner: GitRunner,
  args: ReadonlyArray<string>,
  cwd?: string,
): Promise<string> {
  const result = await runner.run(args, cwd);
  if (result.exitCode !== 0) {
    throw new FactoryError({
      code: "git_command_failed",
      message: `Git command failed with exit code ${result.exitCode}`,
      detail: result.stderr.trim().slice(0, 4_000),
    });
  }
  return result.stdout.trim();
}

export interface WorkspaceOptions {
  readonly root: string;
  readonly runner?: GitRunner;
}

export function githubHttpsRemote(repository: string): string {
  return `https://github.com/${repository}.git`;
}

export function makeWorkspaceService(
  options: WorkspaceOptions,
): WorkspaceService {
  const runner = options.runner ?? nodeGitRunner;
  const root = resolve(options.root);
  const clonesRoot = join(root, "clones");
  const worktreesRoot = join(root, "worktrees");

  return {
    create: (input) =>
      Effect.tryPromise({
        try: async () => {
          if (!REPOSITORY_NAME_PATTERN.test(input.repository)) {
            throw new FactoryError({
              code: "repository_invalid",
              message: `Invalid repository name: ${input.repository}`,
            });
          }
          if (!/^[A-Za-z0-9_.-]+$/.test(input.assignmentId)) {
            throw new FactoryError({
              code: "assignment_id_invalid",
              message: `Invalid assignment ID: ${input.assignmentId}`,
            });
          }
          if (!/^[0-9a-f]{40,64}$/i.test(input.startingCommit)) {
            throw new FactoryError({
              code: "starting_commit_invalid",
              message: "Starting commit must be a full Git object ID",
            });
          }

          await Promise.all([
            mkdir(clonesRoot, { recursive: true }),
            mkdir(worktreesRoot, { recursive: true }),
          ]);
          const canonicalRoot = await realpath(root);
          const slug = input.repository.replace("/", "--");
          const plannedClone = join(clonesRoot, slug);
          const plannedWorktree = join(worktreesRoot, input.assignmentId);
          assertPathWithin(root, plannedClone, "Clone path");
          assertPathWithin(root, plannedWorktree, "Worktree path");

          const remote = githubHttpsRemote(input.repository);
          if (!existsSync(plannedClone)) {
            await checked(runner, [
              GIT_CLI,
              "clone",
              "--no-checkout",
              remote,
              plannedClone,
            ]);
          } else {
            const configuredRemote = await checked(
              runner,
              [GIT_CLI, "remote", "get-url", "origin"],
              plannedClone,
            );
            if (configuredRemote !== remote) {
              throw new FactoryError({
                code: "clone_remote_mismatch",
                message: `Reusable clone remote is ${configuredRemote}, expected ${remote}`,
              });
            }
          }
          const clonePath = await realpath(plannedClone);
          assertPathWithin(canonicalRoot, clonePath, "Canonical clone path");
          await checked(
            runner,
            [GIT_CLI, "fetch", "--prune", "origin"],
            clonePath,
          );
          await checked(
            runner,
            [GIT_CLI, "cat-file", "-e", `${input.startingCommit}^{commit}`],
            clonePath,
          );
          if (existsSync(plannedWorktree)) {
            throw new FactoryError({
              code: "worktree_exists",
              message: `Retained worktree already exists: ${plannedWorktree}`,
            });
          }
          const branch = `factory/${input.assignmentId}`;
          await checked(
            runner,
            [
              GIT_CLI,
              "worktree",
              "add",
              "-b",
              branch,
              plannedWorktree,
              input.startingCommit,
            ],
            clonePath,
          );
          const worktreePath = await realpath(plannedWorktree);
          assertPathWithin(
            canonicalRoot,
            worktreePath,
            "Canonical worktree path",
          );
          const worktreeGitDir = resolve(
            await checked(
              runner,
              [
                GIT_CLI,
                "rev-parse",
                "--path-format=absolute",
                "--absolute-git-dir",
              ],
              worktreePath,
            ),
          );
          const commonGitDir = resolve(
            await checked(
              runner,
              [
                GIT_CLI,
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
              ],
              worktreePath,
            ),
          );
          const canonicalWorktreeGitDir = await realpath(worktreeGitDir);
          const canonicalCommonGitDir = await realpath(commonGitDir);
          assertPathWithin(
            clonePath,
            canonicalWorktreeGitDir,
            "Worktree Git directory",
          );
          assertPathWithin(
            clonePath,
            canonicalCommonGitDir,
            "Common Git directory",
          );
          return {
            clonePath,
            worktreePath,
            worktreeGitDir: canonicalWorktreeGitDir,
            commonGitDir: canonicalCommonGitDir,
            branch,
          };
        },
        catch: (error) =>
          error instanceof FactoryError
            ? error
            : new FactoryError({
                code: "workspace_create_failed",
                message: String(error),
              }),
      }),
  };
}

export const layerWorkspaces = (options: WorkspaceOptions) =>
  Layer.succeed(Workspaces, makeWorkspaceService(options));
