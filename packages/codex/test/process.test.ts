import { describe, expect, test } from "vite-plus/test";
import { spawnManaged, terminateOwnedGroup } from "../src/index.ts";

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
});
