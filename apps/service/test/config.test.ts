import { describe, expect, test } from "vite-plus/test";
import {
  configPathFromArgs,
  DEFAULT_CODEX_SLOTS,
  DEFAULT_MAX_RETAINED_TEXT_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PORT,
  DEFAULT_PROVIDER_TIMEOUTS,
  validateConfig,
  validateIntegrationConfig,
} from "../src/index.ts";

const valid = {
  repositories: [{ repository: "owner/repository" }],
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
  test("accepts the documented config argument", () => {
    expect(configPathFromArgs(["--config", "factory.local.json"], "/srv")).toBe(
      "/srv/factory.local.json",
    );
    expect(configPathFromArgs(["factory.local.json"], "/srv")).toBe(
      "/srv/factory.local.json",
    );
    expect(configPathFromArgs([], "/srv")).toBe("/srv/factory.json");
    expect(() => configPathFromArgs(["--config"], "/srv")).toThrow("usage:");
  });

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

  test("defaults the port and every provider timeout", () => {
    const { port: _port, timeouts: _timeouts, ...source } = valid;
    const config = validateConfig(source);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.timeouts).toEqual(DEFAULT_PROVIDER_TIMEOUTS);
    expect(config.codex.slots).toBe(DEFAULT_CODEX_SLOTS);
    expect(config.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(config.retention).toEqual({
      sensitivePatterns: [],
      maxTextBytes: DEFAULT_MAX_RETAINED_TEXT_BYTES,
    });
  });

  test("validates retained-text redaction and byte limits", () => {
    expect(
      validateConfig({
        ...valid,
        retention: {
          sensitivePatterns: ["token-[0-9]+"],
          maxTextBytes: 512,
        },
      }).retention,
    ).toEqual({ sensitivePatterns: ["token-[0-9]+"], maxTextBytes: 512 });
    expect(() =>
      validateConfig({
        ...valid,
        retention: { sensitivePatterns: ["["] },
      }),
    ).toThrow("invalid regular expression");
    expect(() =>
      validateConfig({ ...valid, retention: { maxTextBytes: 255 } }),
    ).toThrow("retention.maxTextBytes");
  });

  test("merges partial timeout overrides over the defaults", () => {
    const config = validateConfig({
      ...valid,
      timeouts: { turnMs: 42_000, shutdownMs: 2_000 },
    });
    expect(config.timeouts).toEqual({
      ...DEFAULT_PROVIDER_TIMEOUTS,
      turnMs: 42_000,
      shutdownMs: 2_000,
    });
  });

  test.each([0, -1, 1.5, 65_536, Number.NaN])(
    "rejects an invalid supplied port %s",
    (port) => {
      expect(() => validateConfig({ ...valid, port })).toThrow(
        "port must be an integer from 1 through 65535",
      );
    },
  );

  test.each([0, -1, 1.5, Number.NaN])(
    "rejects an invalid supplied timeout %s",
    (turnMs) => {
      expect(() => validateConfig({ ...valid, timeouts: { turnMs } })).toThrow(
        "turnMs must be a positive integer",
      );
    },
  );

  test("uses a narrow integration projection", () => {
    const integration = validateIntegrationConfig({
      repository: 42,
      databasePath: false,
      workspaceRoot: null,
      bindHost: ["not", "used"],
      port: 0,
      codex: valid.codex,
      timeouts: { initializationMs: 321 },
    });
    expect(integration).toEqual({
      codex: { ...valid.codex, slots: DEFAULT_CODEX_SLOTS },
      timeouts: { ...DEFAULT_PROVIDER_TIMEOUTS, initializationMs: 321 },
    });
  });

  test("normalizes repositories and resolves independent Codex overrides", () => {
    const config = validateConfig({
      ...valid,
      codex: {
        model: "global-model",
        reasoningEffort: "medium",
        slots: 32,
      },
      pollIntervalMs: 1_000,
      repositories: [
        { repository: "Owner/One", codex: { model: "repo-model" } },
        {
          repository: "owner/Two",
          codex: { reasoningEffort: "high" },
        },
      ],
    });
    expect(config.repositories).toEqual([
      {
        repository: "owner/one",
        codex: { model: "repo-model", reasoningEffort: "medium" },
      },
      {
        repository: "owner/two",
        codex: { model: "global-model", reasoningEffort: "high" },
      },
    ]);
    expect(config.codex.slots).toBe(32);
    expect(config.pollIntervalMs).toBe(1_000);
  });

  test("requires a nonempty unique repository pool", () => {
    expect(() => validateConfig({ ...valid, repositories: [] })).toThrow(
      "at least one repository",
    );
    expect(() =>
      validateConfig({
        ...valid,
        repositories: [
          { repository: "Owner/Repo" },
          { repository: "owner/repo" },
        ],
      }),
    ).toThrow("duplicate owner/repo");
    const { repositories: _repositories, ...withoutRepositories } = valid;
    expect(() => validateConfig(withoutRepositories)).toThrow(
      "required structure",
    );
  });

  test.each([0, 33, 1.5])("rejects invalid Codex slots %s", (slots) => {
    expect(() =>
      validateConfig({ ...valid, codex: { ...valid.codex, slots } }),
    ).toThrow("codex.slots must be an integer from 1 through 32");
  });

  test.each([999, 3_600_001, 1.5])(
    "rejects invalid poll intervals %s",
    (pollIntervalMs) => {
      expect(() => validateConfig({ ...valid, pollIntervalMs })).toThrow(
        "pollIntervalMs must be an integer from 1000 through 3600000",
      );
    },
  );

  test("validates integration Codex settings and supplied timeouts", () => {
    expect(() =>
      validateIntegrationConfig({
        codex: { model: "", reasoningEffort: "low" },
      }),
    ).toThrow("Codex model and reasoning effort must be explicit");
    expect(() =>
      validateIntegrationConfig({
        codex: valid.codex,
        timeouts: { shutdownMs: 0 },
      }),
    ).toThrow("shutdownMs must be a positive integer");
  });
});
