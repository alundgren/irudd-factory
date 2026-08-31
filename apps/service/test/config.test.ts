import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/index.ts";

const valid = {
  repository: "owner/repository",
  databasePath: ".factory/factory.db",
  workspaceRoot: ".factory/workspaces",
  bindHost: "127.0.0.1",
  port: 4317,
  codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
  timeouts: {
    childStartupMs: 1,
    initializationMs: 1,
    modelSchemaMs: 1,
    turnMs: 1,
    shutdownMs: 1,
  },
};

describe("factory configuration", () => {
  test("resolves paths and accepts loopback addresses", () => {
    const config = validateConfig(valid, "/opt/factory");
    expect(config.databasePath).toBe("/opt/factory/.factory/factory.db");
    expect(config.workspaceRoot).toBe("/opt/factory/.factory/workspaces");
    expect(validateConfig({ ...valid, bindHost: "::1" }).bindHost).toBe("::1");
    expect(
      validateConfig({ ...valid, bindHost: "127.10.20.30" }).bindHost,
    ).toBe("127.10.20.30");
  });

  test("rejects non-loopback service access", () => {
    expect(() => validateConfig({ ...valid, bindHost: "0.0.0.0" })).toThrow(
      "only accepts a loopback bind address",
    );
    expect(() => validateConfig({ ...valid, bindHost: "localhost" })).toThrow(
      "only accepts a loopback bind address",
    );
  });

  test("requires every positive integer timeout", () => {
    expect(() =>
      validateConfig({
        ...valid,
        timeouts: { ...valid.timeouts, turnMs: 0 },
      }),
    ).toThrow("turnMs must be a positive integer");
  });
});
