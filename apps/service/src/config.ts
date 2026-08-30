import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FactoryError } from "@irudd-factory/application";
import type { ProviderTimeouts } from "@irudd-factory/codex";
import { Schema } from "effect";

const RawConfig = Schema.Struct({
  repository: Schema.String,
  databasePath: Schema.String,
  workspaceRoot: Schema.String,
  bindHost: Schema.String,
  port: Schema.Number,
  codex: Schema.Struct({
    model: Schema.String,
    reasoningEffort: Schema.String,
  }),
  timeouts: Schema.Struct({
    childStartupMs: Schema.Number,
    initializationMs: Schema.Number,
    modelSchemaMs: Schema.Number,
    turnMs: Schema.Number,
    shutdownMs: Schema.Number,
  }),
});

export interface FactoryConfig {
  readonly repository: string;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly bindHost: string;
  readonly port: number;
  readonly codex: {
    readonly model: string;
    readonly reasoningEffort: string;
  };
  readonly timeouts: ProviderTimeouts;
}

export function validateConfig(
  source: unknown,
  configDirectory = process.cwd(),
): FactoryConfig {
  let raw: typeof RawConfig.Type;
  try {
    raw = Schema.decodeUnknownSync(RawConfig)(source);
  } catch (error) {
    throw new FactoryError({
      code: "config_invalid",
      message: "factory.json does not match the required structure",
      detail: String(error),
    });
  }
  const ipv4 = raw.bindHost.split(".").map(Number);
  const loopback =
    raw.bindHost === "::1" ||
    (ipv4.length === 4 &&
      ipv4[0] === 127 &&
      ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255));
  if (!loopback) {
    throw new FactoryError({
      code: "non_loopback_bind_rejected",
      message: `Factory only accepts a loopback bind address, got ${raw.bindHost}`,
    });
  }
  if (!Number.isSafeInteger(raw.port) || raw.port <= 0 || raw.port > 65_535) {
    throw new FactoryError({
      code: "config_invalid",
      message: "port must be an integer from 1 through 65535",
    });
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository)) {
    throw new FactoryError({
      code: "config_invalid",
      message: "repository must use owner/name form",
    });
  }
  if (!raw.codex.model.trim() || !raw.codex.reasoningEffort.trim()) {
    throw new FactoryError({
      code: "config_invalid",
      message: "Codex model and reasoning effort must be explicit",
    });
  }
  for (const [name, value] of Object.entries(raw.timeouts)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new FactoryError({
        code: "config_invalid",
        message: `${name} must be a positive integer millisecond timeout`,
      });
    }
  }
  return {
    ...raw,
    databasePath: resolve(configDirectory, raw.databasePath),
    workspaceRoot: resolve(configDirectory, raw.workspaceRoot),
  };
}

export async function loadConfig(path = resolve("factory.json")) {
  let source: unknown;
  try {
    source = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new FactoryError({
      code: "config_read_failed",
      message: `Could not read ${path}`,
      detail: String(error),
    });
  }
  return validateConfig(source, dirname(path));
}
