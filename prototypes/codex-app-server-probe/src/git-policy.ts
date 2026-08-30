import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ProbeError } from "./types.ts";

export function gitGlobalConfigPath(workspace: string): string {
  return join(workspace, ".git", "probe-global-config");
}

async function requirePlainGitTree(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata) return;
  if (metadata.isSymbolicLink()) {
    throw new ProbeError(
      "assertion_failed",
      "git_metadata_link_rejected",
      `Copied Git metadata contains a symbolic link: ${path}`,
    );
  }
  if (metadata.isFile()) return;
  if (!metadata.isDirectory()) {
    throw new ProbeError(
      "assertion_failed",
      "git_metadata_type_rejected",
      `Copied Git metadata is neither a regular file nor a directory: ${path}`,
    );
  }
  const entries = await readdir(path);
  for (const entry of entries) await requirePlainGitTree(join(path, entry));
}

export async function readLocalOrigin(workspace: string): Promise<string> {
  const gitDirectory = join(workspace, ".git");
  const metadata = await lstat(gitDirectory).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new ProbeError(
      "assertion_failed",
      "git_directory_required",
      "The seeded checkout must have its own .git directory",
    );
  }
  const config = await readFile(join(gitDirectory, "config"), "utf8");
  const originSection = config.match(
    /\[remote\s+"origin"\]([\s\S]*?)(?=\n\s*\[|$)/,
  )?.[1];
  const url = originSection?.match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1];
  if (!url) {
    throw new ProbeError(
      "assertion_failed",
      "origin_remote_missing",
      "The seeded checkout has no origin URL in .git/config",
    );
  }
  return url;
}

export async function sanitizeCopiedGitDirectory(
  workspace: string,
  expectedRemote: string,
): Promise<void> {
  await requirePlainGitTree(join(workspace, ".git"));
  const actualRemote = await readLocalOrigin(workspace);
  if (actualRemote !== expectedRemote) {
    throw new ProbeError(
      "assertion_failed",
      "target_remote_mismatch",
      `Expected ${expectedRemote}, got ${actualRemote}`,
    );
  }
  const gitDirectory = join(workspace, ".git");
  await Promise.all([
    rm(join(gitDirectory, "hooks"), { recursive: true, force: true }),
    rm(join(gitDirectory, "config.worktree"), { force: true }),
    rm(join(gitDirectory, "objects", "info", "alternates"), { force: true }),
  ]);
  await mkdir(join(gitDirectory, "hooks"), { mode: 0o700 });
  await writeFile(
    join(gitDirectory, "config"),
    [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfilemode = true",
      "\tbare = false",
      "\tlogallrefupdates = true",
      '[remote "origin"]',
      `\turl = ${expectedRemote}`,
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(gitGlobalConfigPath(workspace), "", { mode: 0o600 });
}
