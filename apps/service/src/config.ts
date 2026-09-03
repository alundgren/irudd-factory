import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  FactoryError,
  REPOSITORY_NAME_PATTERN,
} from "@irudd-factory/application";
import type { ProviderTimeouts } from "@irudd-factory/codex";
import { Schema } from "effect";

/** The configuration file Factory reads, and the flag that overrides it. */
export const CONFIG_FILE_NAME = "factory.json";
export const CONFIG_FLAG = "--config";

export const DEFAULT_PORT = 4317;
export const DEFAULT_CODEX_SLOTS = 1;
export const MIN_CODEX_SLOTS = 1;
export const MAX_CODEX_SLOTS = 32;
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS = 1_000;
export const MAX_POLL_INTERVAL_MS = 3_600_000;
export const DEFAULT_MAX_RETAINED_TEXT_BYTES = 64 * 1024;
export const DEFAULT_PROVIDER_TIMEOUTS: ProviderTimeouts = Object.freeze({
  childStartupMs: 10_000,
  initializationMs: 10_000,
  modelSchemaMs: 20_000,
  turnMs: 600_000,
  shutdownMs: 5_000,
});

const RawCodex = Schema.Struct({
  model: Schema.String,
  reasoningEffort: Schema.String,
  slots: Schema.optional(Schema.Number),
});

const RawRepository = Schema.Struct({
  repository: Schema.String,
  codex: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      reasoningEffort: Schema.optional(Schema.String),
    }),
  ),
});

const RawTimeouts = Schema.Struct({
  childStartupMs: Schema.optional(Schema.Number),
  initializationMs: Schema.optional(Schema.Number),
  modelSchemaMs: Schema.optional(Schema.Number),
  turnMs: Schema.optional(Schema.Number),
  shutdownMs: Schema.optional(Schema.Number),
});

const RawRetention = Schema.Struct({
  sensitivePatterns: Schema.optional(Schema.Array(Schema.String)),
  maxTextBytes: Schema.optional(Schema.Number),
});

const RawConfig = Schema.Struct({
  repositories: Schema.Array(RawRepository),
  databasePath: Schema.String,
  workspaceRoot: Schema.String,
  bindHost: Schema.String,
  port: Schema.optional(Schema.Number),
  pollIntervalMs: Schema.optional(Schema.Number),
  codex: RawCodex,
  timeouts: Schema.optional(RawTimeouts),
  retention: Schema.optional(RawRetention),
});

const RawIntegrationConfig = Schema.Struct({
  codex: RawCodex,
  timeouts: Schema.optional(RawTimeouts),
});

export interface FactoryConfig {
  readonly repositories: ReadonlyArray<{
    readonly repository: string;
    readonly codex: {
      readonly model: string;
      readonly reasoningEffort: string;
    };
  }>;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly bindHost: string;
  readonly port: number;
  readonly pollIntervalMs: number;
  readonly codex: {
    readonly model: string;
    readonly reasoningEffort: string;
    readonly slots: number;
  };
  readonly timeouts: ProviderTimeouts;
  readonly retention?: {
    readonly sensitivePatterns: ReadonlyArray<string>;
    readonly maxTextBytes: number;
  };
}

export interface IntegrationConfig {
  readonly codex: {
    readonly model: string;
    readonly reasoningEffort: string;
    readonly slots: number;
  };
  readonly timeouts: ProviderTimeouts;
}

function invalidStructure(error: unknown): FactoryError {
  return new FactoryError({
    code: "config_invalid",
    message: `${CONFIG_FILE_NAME} does not match the required structure`,
    detail: String(error),
  });
}

function validateCodex(codex: {
  readonly model: string;
  readonly reasoningEffort: string;
}): void {
  if (!codex.model.trim() || !codex.reasoningEffort.trim()) {
    throw new FactoryError({
      code: "config_invalid",
      message: "Codex model and reasoning effort must be explicit",
    });
  }
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FactoryError({
      code: "config_invalid",
      message: `${name} must be an integer from ${minimum} through ${maximum}`,
    });
  }
  return value;
}

function resolveTimeouts(
  supplied:
    | { readonly [Key in keyof ProviderTimeouts]?: number | undefined }
    | undefined,
): ProviderTimeouts {
  const timeouts = { ...DEFAULT_PROVIDER_TIMEOUTS };
  for (const [name, value] of Object.entries(supplied ?? {})) {
    if (value !== undefined) {
      timeouts[name as keyof ProviderTimeouts] = value;
    }
  }
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new FactoryError({
        code: "config_invalid",
        message: `${name} must be a positive integer millisecond timeout`,
      });
    }
  }
  return timeouts;
}

export function validateConfig(
  source: unknown,
  configDirectory = process.cwd(),
): FactoryConfig {
  let raw: typeof RawConfig.Type;
  try {
    raw = Schema.decodeUnknownSync(RawConfig)(source);
  } catch (error) {
    throw invalidStructure(error);
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
  const port = raw.port ?? DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new FactoryError({
      code: "config_invalid",
      message: "port must be an integer from 1 through 65535",
    });
  }
  validateCodex(raw.codex);
  if (raw.repositories.length === 0) {
    throw new FactoryError({
      code: "config_invalid",
      message: "repositories must contain at least one repository",
    });
  }
  const seen = new Set<string>();
  const repositories = raw.repositories.map((entry) => {
    if (!REPOSITORY_NAME_PATTERN.test(entry.repository)) {
      throw new FactoryError({
        code: "config_invalid",
        message: "repository must use owner/name form",
      });
    }
    const repository = entry.repository.toLowerCase();
    if (seen.has(repository)) {
      throw new FactoryError({
        code: "config_invalid",
        message: `repositories contains duplicate ${repository}`,
      });
    }
    seen.add(repository);
    const effective = {
      model: entry.codex?.model ?? raw.codex.model,
      reasoningEffort:
        entry.codex?.reasoningEffort ?? raw.codex.reasoningEffort,
    };
    validateCodex(effective);
    return { repository, codex: effective };
  });
  const slots = boundedInteger(
    raw.codex.slots ?? DEFAULT_CODEX_SLOTS,
    "codex.slots",
    MIN_CODEX_SLOTS,
    MAX_CODEX_SLOTS,
  );
  const pollIntervalMs = boundedInteger(
    raw.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
  );
  const maxTextBytes = boundedInteger(
    raw.retention?.maxTextBytes ?? DEFAULT_MAX_RETAINED_TEXT_BYTES,
    "retention.maxTextBytes",
    256,
    16 * 1024 * 1024,
  );
  for (const pattern of raw.retention?.sensitivePatterns ?? []) {
    try {
      new RegExp(pattern, "u");
    } catch (error) {
      throw new FactoryError({
        code: "config_invalid",
        message:
          "retention.sensitivePatterns contains an invalid regular expression",
        detail: String(error),
      });
    }
  }
  return {
    repositories,
    databasePath: resolve(configDirectory, raw.databasePath),
    workspaceRoot: resolve(configDirectory, raw.workspaceRoot),
    bindHost: raw.bindHost,
    port,
    pollIntervalMs,
    codex: { ...raw.codex, slots },
    timeouts: resolveTimeouts(raw.timeouts),
    retention: {
      sensitivePatterns: raw.retention?.sensitivePatterns ?? [],
      maxTextBytes,
    },
  };
}

export function validateIntegrationConfig(source: unknown): IntegrationConfig {
  let raw: typeof RawIntegrationConfig.Type;
  try {
    raw = Schema.decodeUnknownSync(RawIntegrationConfig)(source);
  } catch (error) {
    throw invalidStructure(error);
  }
  validateCodex(raw.codex);
  const slots = boundedInteger(
    raw.codex.slots ?? DEFAULT_CODEX_SLOTS,
    "codex.slots",
    MIN_CODEX_SLOTS,
    MAX_CODEX_SLOTS,
  );
  return {
    codex: {
      model: raw.codex.model,
      reasoningEffort: raw.codex.reasoningEffort,
      slots,
    },
    timeouts: resolveTimeouts(raw.timeouts),
  };
}

export async function loadConfig(path = resolve(CONFIG_FILE_NAME)) {
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

export async function loadIntegrationConfig(path = resolve(CONFIG_FILE_NAME)) {
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
  return validateIntegrationConfig(source);
}

export function configPathFromArgs(
  args: ReadonlyArray<string>,
  workingDirectory = process.cwd(),
): string {
  if (args.length === 0) return resolve(workingDirectory, CONFIG_FILE_NAME);
  if (args.length === 1 && args[0] && args[0] !== CONFIG_FLAG) {
    return resolve(workingDirectory, args[0]);
  }
  if (args.length === 2 && args[0] === CONFIG_FLAG && args[1]) {
    return resolve(workingDirectory, args[1]);
  }
  throw new FactoryError({
    code: "config_arguments_invalid",
    message: `usage: factory-service [${CONFIG_FLAG} path|path]`,
  });
}
