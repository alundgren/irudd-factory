import { describe, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { runFixtureCommand } from "../fixtures/command.ts";
import { FIXTURE_REGISTRY } from "../fixtures/registry.ts";
import type { FixtureDefinition } from "../fixtures/types.ts";

const execFileAsync = promisify(execFile);
const directCommandEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("VP_")),
);
directCommandEnvironment.PATH = directCommandEnvironment.PATH?.split(delimiter)
  .filter((entry) => entry !== resolve("node_modules/.bin"))
  .join(delimiter);

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls = { build: 0, launch: 0 };
  return {
    stdout,
    stderr,
    calls,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
    actions: {
      buildConsole: async () => {
        calls.build++;
      },
      launch: async (_fixture: FixtureDefinition) => {
        calls.launch++;
      },
    },
  };
}

async function fingerprint(path: string): Promise<unknown> {
  try {
    const entry = await lstat(path);
    if (entry.isFile()) {
      const content = await readFile(path);
      return {
        type: "file",
        size: entry.size,
        modified: entry.mtimeMs,
        hash: createHash("sha256").update(content).digest("hex"),
      };
    }
    const names = (await readdir(path)).toSorted();
    return {
      type: "directory",
      entries: await Promise.all(
        names.map(async (name) => [
          name,
          await fingerprint(resolve(path, name)),
        ]),
      ),
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

describe("fixture command dispatch", () => {
  test("lists and describes fixtures without build or launch work", async () => {
    for (const args of [
      [],
      ["--json"],
      ["runnable", "--describe"],
      ["runnable", "--describe", "--json"],
    ]) {
      const output = capture();
      await expect(
        runFixtureCommand(args, {}, output.io, output.actions),
      ).resolves.toBe(0);
      expect(output.stderr).toEqual([]);
      expect(output.calls).toEqual({ build: 0, launch: 0 });
    }
  });

  test("rejects invalid forms before build or launch work", async () => {
    for (const args of [
      ["unknown"],
      ["--describe"],
      ["runnable", "--json"],
      ["runnable", "--describe", "--describe"],
      ["runnable", "extra"],
    ]) {
      const output = capture();
      await expect(
        runFixtureCommand(args, {}, output.io, output.actions),
      ).resolves.toBe(2);
      expect(output.stdout).toEqual([]);
      expect(output.stderr.join("")).toContain("fixture_arguments_invalid");
      expect(output.stderr.join("")).toContain("usage: vp run fixture");
      expect(output.stderr.join("")).toContain(
        "vp node scripts/fixture.ts --json",
      );
      expect(output.calls).toEqual({ build: 0, launch: 0 });
    }
  });

  test("refuses production launch before build, dependencies, or listeners", async () => {
    const output = capture();
    await expect(
      runFixtureCommand(
        ["runnable"],
        { NODE_ENV: "production" },
        output.io,
        output.actions,
      ),
    ).resolves.toBe(2);
    expect(output.stderr.join("")).toContain(
      "fixture_production_forbidden: Fixtures cannot launch",
    );
    expect(output.calls).toEqual({ build: 0, launch: 0 });
  });

  test("builds once before launching a valid development fixture", async () => {
    const output = capture();
    await expect(
      runFixtureCommand(["runnable"], {}, output.io, output.actions),
    ).resolves.toBe(0);
    expect(output.calls).toEqual({ build: 1, launch: 1 });
  });
});

describe("fixture command process", () => {
  test("emits compact JSON only and keeps inspection paths unchanged", async () => {
    const paths = [resolve(".factory/fixtures"), resolve("apps/console/dist")];
    const before = await Promise.all(paths.map(fingerprint));
    const compact = await execFileAsync(
      "vp",
      ["node", "scripts/fixture.ts", "--json"],
      { cwd: resolve("."), env: directCommandEnvironment },
    );
    const parsed = JSON.parse(compact.stdout) as unknown[];
    expect(parsed).toHaveLength(FIXTURE_REGISTRY.length);
    expect(parsed).toEqual(
      FIXTURE_REGISTRY.map(({ name, summary, tags }) => ({
        name,
        summary,
        tags,
      })),
    );
    expect(compact.stderr).toBe("");

    const detailed = await execFileAsync(
      "vp",
      ["node", "scripts/fixture.ts", "runnable", "--describe", "--json"],
      { cwd: resolve("."), env: directCommandEnvironment },
    );
    expect(JSON.parse(detailed.stdout)).toMatchObject({
      name: "runnable",
      expectations: { command: { result: "started" } },
    });
    expect(detailed.stderr).toBe("");

    await execFileAsync("vp", ["run", "fixture", "runnable", "--describe"], {
      cwd: resolve("."),
    });
    await expect(
      execFileAsync("vp", ["run", "fixture", "unknown"], {
        cwd: resolve("."),
      }),
    ).rejects.toMatchObject({ code: 2 });
    await expect(
      execFileAsync("vp", ["run", "fixture", "runnable"], {
        cwd: resolve("."),
        env: { ...process.env, NODE_ENV: "production" },
      }),
    ).rejects.toMatchObject({ code: 2 });
    expect(await Promise.all(paths.map(fingerprint))).toEqual(before);
  }, 20_000);
});
