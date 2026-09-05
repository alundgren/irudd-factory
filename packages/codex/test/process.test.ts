import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { Either, Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import type { ManagedProcess } from "../src/index.ts";
import {
  runManagedCommand,
  spawnManaged,
  terminateOwnedGroup,
} from "../src/index.ts";

describe("owned provider processes", () => {
  test("terminates only the tracked process group within one deadline", async () => {
    const child = spawnManaged(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      process.cwd(),
    );
    const started = Date.now();
    const result = await terminateOwnedGroup(child, 500);
    expect(result.cleanupTimedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("reports cleanup timeout without exceeding the deadline", async () => {
    const child = spawnManaged(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      process.cwd(),
    );
    const started = Date.now();
    const result = await terminateOwnedGroup(child, 50, () => {});
    expect(result.cleanupTimedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(150);
    await terminateOwnedGroup(child, 500);
  });

  test("reports cleanup timeout when command termination rejects", async () => {
    let captured: ManagedProcess | undefined;
    try {
      const outcome = await Effect.runPromise(
        Effect.either(
          Effect.tryPromise({
            try: () =>
              runManagedCommand({
                command: [
                  process.execPath,
                  "-e",
                  "setInterval(() => {}, 1000)",
                ],
                cwd: process.cwd(),
                timeoutMs: 20,
                timeoutCode: "child_startup_timeout",
                terminateProcessGroup: async (child) => {
                  captured = child;
                  throw new Error("termination failed");
                },
              }),
            catch: (error) => error,
          }),
        ),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toMatchObject({
          code: "child_startup_timeout",
          detail: "cleanup_timeout",
        });
      }
    } finally {
      if (captured) await terminateOwnedGroup(captured, 500);
    }
  });
});

test("escalates to SIGKILL for an owned group with a descendant that ignores SIGTERM", async () => {
  const child = spawnManaged(
    [
      process.execPath,
      "-e",
      `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
      descendant.stdout.once('data', () => console.log(descendant.pid));
      setInterval(() => {}, 1000);
    `,
    ],
    process.cwd(),
  );
  try {
    const [data] = await once(child.process.stdout, "data");
    const descendantPid = Number(String(data).trim());
    expect(descendantPid).toBeGreaterThan(1);
    const result = await terminateOwnedGroup(child, 2_000);
    expect(result).toMatchObject({ signal: "SIGKILL", cleanupTimedOut: false });
    expect(child.hasExited).toBe(true);
    // A killed grandchild can remain a zombie until the host's init reaps it.
    const stat = await readFile(`/proc/${descendantPid}/stat`, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") return null;
        throw error;
      },
    );
    if (stat !== null)
      expect(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]).toBe("Z");
  } finally {
    await terminateOwnedGroup(child, 2_000);
  }
});
