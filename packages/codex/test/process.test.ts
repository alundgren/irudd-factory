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
