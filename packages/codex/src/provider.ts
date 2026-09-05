import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  ProviderRunResult,
  ProviderService,
} from "@irudd-factory/application";
import { FactoryError, Provider } from "@irudd-factory/application";
import {
  ASSIGNMENT_EVENTS,
  type RetainedProviderRecord,
} from "@irudd-factory/contracts";
import { Effect, Layer } from "effect";
import {
  runManagedCommand,
  getProcessStartIdentity,
  spawnManaged,
  terminateOwnedGroup,
  type ManagedProcess,
  type ProcessExit,
} from "./process.ts";
import { AppServerRpc, APP_SERVER_METHODS } from "./rpc.ts";
import { createProtocolRun, type ProtocolTimeouts } from "./protocol.ts";

export interface ProviderTimeouts extends ProtocolTimeouts {
  readonly shutdownMs: number;
}

export interface CodexProviderOptions {
  readonly commandPrefix?: ReadonlyArray<string>;
  readonly runtimeRoot: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly timeouts: ProviderTimeouts;
  readonly terminateProcessGroup?: (
    child: ManagedProcess,
    shutdownMs: number,
  ) => Promise<ProcessExit>;
}

interface PreparedCodex {
  readonly codexVersion: string;
  readonly schemaDigest: string;
}

interface CodexProviderDependencies {
  readonly prepareCodex?: (request: {
    readonly prefix: ReadonlyArray<string>;
    readonly cwd: string;
    readonly schemaRoot: string;
    readonly timeouts: ProviderTimeouts;
  }) => Promise<PreparedCodex>;
}

/** The Codex executable Factory launches when no prefix is configured. */
const CODEX_COMMAND = "codex";

const RequiredSchemaMarkers = [
  "InitializeParams",
  "ThreadStartParams",
  "TurnStartParams",
  "TurnCompletedNotification",
  "TurnInterruptParams",
  "ItemStartedNotification",
  "ItemCompletedNotification",
  "ThreadTokenUsageUpdatedNotification",
  "ModelReroutedNotification",
];

function validateTimeouts(timeouts: ProviderTimeouts): void {
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new FactoryError({
        code: "provider_timeout_invalid",
        message: `${name} must be a positive integer`,
      });
    }
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory()
        ? listFiles(root, path)
        : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

async function inspectSchemas(root: string): Promise<string> {
  const paths = (await listFiles(root)).sort((a, b) =>
    relative(root, a).localeCompare(relative(root, b)),
  );
  const names = paths.map((path) => relative(root, path).replaceAll("\\", "/"));
  const missing = RequiredSchemaMarkers.filter(
    (marker) => !names.some((name) => name.includes(marker)),
  );
  if (missing.length > 0) {
    throw new FactoryError({
      code: "provider_schema_incompatible",
      message: `Generated App Server schema lacks ${missing.join(", ")}`,
    });
  }
  const digest = createHash("sha256");
  for (let index = 0; index < paths.length; index += 1) {
    digest.update(names[index] ?? "");
    digest.update("\0");
    digest.update(await readFile(paths[index]!));
  }
  return digest.digest("hex");
}

function normalizeVersion(stdout: string): string {
  const version = stdout
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  if (!version) {
    throw new FactoryError({
      code: "codex_version_failed",
      message: "codex --version returned no version",
    });
  }
  return version.slice(0, 200);
}

async function prepareCodex(request: {
  readonly prefix: ReadonlyArray<string>;
  readonly cwd: string;
  readonly schemaRoot: string;
  readonly timeouts: ProviderTimeouts;
}): Promise<PreparedCodex> {
  const version = await runManagedCommand({
    command: [...request.prefix, "--version"],
    cwd: request.cwd,
    timeoutMs: request.timeouts.childStartupMs,
    timeoutCode: "child_startup_timeout",
  });
  if (version.code !== 0) {
    throw new FactoryError({
      code: "codex_version_failed",
      message: `codex --version exited with code ${version.code}`,
    });
  }
  const schema = await runManagedCommand({
    command: [
      ...request.prefix,
      "app-server",
      "generate-json-schema",
      "--out",
      request.schemaRoot,
    ],
    cwd: request.cwd,
    timeoutMs: request.timeouts.modelSchemaMs,
    timeoutCode: "model_schema_timeout",
  });
  if (schema.code !== 0) {
    throw new FactoryError({
      code: "schema_generation_failed",
      message: `App Server schema generation exited with code ${schema.code}`,
    });
  }
  return {
    codexVersion: normalizeVersion(version.stdout),
    schemaDigest: await inspectSchemas(request.schemaRoot),
  };
}

export function makeCodexProvider(
  options: CodexProviderOptions,
  dependencies: CodexProviderDependencies = {},
): ProviderService {
  validateTimeouts(options.timeouts);
  const prefix = options.commandPrefix ?? [CODEX_COMMAND];
  const terminateProcessGroup =
    options.terminateProcessGroup ?? terminateOwnedGroup;
  if (prefix.length === 0) {
    throw new FactoryError({
      code: "provider_command_invalid",
      message: "Codex command prefix cannot be empty",
    });
  }

  return {
    run: (input, emit, retain) =>
      Effect.tryPromise({
        try: async (signal): Promise<ProviderRunResult> => {
          const runtime = resolve(options.runtimeRoot, input.assignment.id);
          const schemaRoot = join(runtime, "schema");
          await mkdir(schemaRoot, { recursive: true });
          const { codexVersion, schemaDigest } = await (
            dependencies.prepareCodex ?? prepareCodex
          )({
            prefix,
            cwd: input.workspace.worktreePath,
            schemaRoot,
            timeouts: options.timeouts,
          });
          if (signal.aborted) {
            throw new FactoryError({
              code: "service_shutdown",
              message: "Factory service is shutting down",
            });
          }
          const child = spawnManaged(
            [...prefix, "app-server", "--stdio", "--strict-config"],
            input.workspace.worktreePath,
          );
          const processStartIdentity = getProcessStartIdentity(child.pid);
          const rpc = new AppServerRpc(child);
          const protocol = createProtocolRun(
            rpc,
            input,
            (event) =>
              emit({
                ...event,
                ...(event.type === ASSIGNMENT_EVENTS.providerThreadStarted
                  ? { detail: { ...event.detail, schemaDigest } }
                  : {}),
                ...(event.patch?.threadId
                  ? { patch: { ...event.patch, codexVersion } }
                  : {}),
              }),
            retain,
            options,
            signal,
          );
          const { guardTerminal, throwIfTerminal } = protocol;
          rpc.start();
          let processExit: ProcessExit | null = null;
          let cleanupDeadline: number | null = null;
          try {
            await guardTerminal(() =>
              Effect.runPromise(
                emit({
                  type: ASSIGNMENT_EVENTS.providerProcessStarted,
                  timestamp: new Date().toISOString(),
                  detail: {
                    pid: child.pid,
                    processStartIdentity,
                    schemaDigest,
                  },
                  patch: {
                    codexVersion,
                    processGroupId: child.pid,
                    processStartIdentity,
                    processStartPending: false,
                  },
                }),
              ),
            );
            const outcome = await protocol.run();
            cleanupDeadline = Date.now() + options.timeouts.shutdownMs;
            rpc.expectProcessExit();
            throwIfTerminal();
            processExit = await guardTerminal(() =>
              terminateProcessGroup(
                child,
                Math.max(0, cleanupDeadline! - Date.now()),
              ),
            );
            if (processExit.cleanupTimedOut) {
              throw new FactoryError({
                code: "cleanup_timeout",
                message: "Codex process group did not exit before shutdownMs",
              });
            }
            await guardTerminal(() => rpc.drainOutput());
            throwIfTerminal();
            const exitRecords: RetainedProviderRecord[] = [
              {
                kind: "process_exit",
                timestamp: new Date().toISOString(),
                code: processExit.code,
                signal: processExit.signal,
                cleanupTimedOut: processExit.cleanupTimedOut,
              },
            ];
            if (retain) await Effect.runPromise(retain(exitRecords));
            const latest = protocol.snapshot();
            const result: ProviderRunResult = {
              codexVersion,
              finalResponse: latest.finalResponse,
              itemSummaries: latest.itemSummaries,
              tokenUsage: latest.tokenUsage,
              approvalCount: latest.approvalCount,
              threadId: outcome.threadId,
              turnId: outcome.turnId,
              observedModel: latest.observedModel!,
              observedEffort: latest.observedEffort!,
              processExit: {
                code: processExit.code,
                signal: processExit.signal,
                schemaDigest,
              },
              records: retain ? [] : [...latest.records, ...exitRecords],
            };
            throwIfTerminal();
            return result;
          } catch (primary) {
            const { threadId, turnId } = protocol.snapshot();
            cleanupDeadline ??= Date.now() + options.timeouts.shutdownMs;
            if (!processExit && threadId && turnId && !child.hasExited) {
              const interruptMs = Math.min(
                options.timeouts.initializationMs,
                Math.max(0, cleanupDeadline - Date.now()),
                Math.max(1, Math.floor(options.timeouts.shutdownMs / 2)),
              );
              if (interruptMs > 0) {
                try {
                  await rpc.request(
                    APP_SERVER_METHODS.turnInterrupt,
                    { threadId, turnId },
                    interruptMs,
                    "interrupt_timeout",
                  );
                } catch {
                  // The primary failure remains authoritative.
                }
              }
            }
            if (!processExit) {
              rpc.expectProcessExit();
              const remainingMs = Math.max(0, cleanupDeadline - Date.now());
              try {
                processExit = await terminateProcessGroup(child, remainingMs);
              } catch {
                processExit = {
                  code: null,
                  signal: null,
                  cleanupTimedOut: true,
                };
              }
            }
            const {
              approvalCount,
              reroutes,
              itemSummaries,
              tokenUsage,
              finalResponse,
              records: retainedRecords,
            } = protocol.snapshot();
            try {
              await Effect.runPromise(
                emit({
                  type: ASSIGNMENT_EVENTS.providerFailed,
                  timestamp: new Date().toISOString(),
                  detail: {
                    code:
                      primary instanceof FactoryError
                        ? primary.code
                        : "provider_failed",
                    approvalCount,
                    reroutes,
                    itemSummaries,
                    tokenUsage,
                    finalResponse,
                    processExit,
                  },
                  records: [
                    ...retainedRecords,
                    {
                      kind: "error" as const,
                      timestamp: new Date().toISOString(),
                      code:
                        primary instanceof FactoryError
                          ? primary.code
                          : "provider_failed",
                      message:
                        primary instanceof FactoryError
                          ? primary.message
                          : "Codex provider failed unexpectedly",
                    },
                    ...(processExit
                      ? [
                          {
                            kind: "process_exit" as const,
                            timestamp: new Date().toISOString(),
                            code: processExit.code,
                            signal: processExit.signal,
                            cleanupTimedOut: processExit.cleanupTimedOut,
                          },
                        ]
                      : []),
                  ],
                  ...(processExit.cleanupTimedOut
                    ? { patch: { state: "ownership_uncertain" as const } }
                    : {}),
                }),
              );
            } catch {
              // State persistence failure is handled by the application layer.
            }
            if (processExit.cleanupTimedOut) {
              throw new FactoryError({
                code:
                  primary instanceof FactoryError
                    ? primary.code
                    : "provider_failed",
                message:
                  primary instanceof FactoryError
                    ? primary.message
                    : "Codex provider failed unexpectedly",
                detail: "cleanup_timeout",
              });
            }
            throw primary;
          } finally {
            protocol.dispose();
            rpc.stop();
          }
        },
        catch: (error) =>
          error instanceof FactoryError
            ? error
            : new FactoryError({
                code: "provider_failed",
                message: "Codex provider failed unexpectedly",
              }),
      }),
  };
}

export const layerCodexProvider = (options: CodexProviderOptions) =>
  Layer.succeed(Provider, makeCodexProvider(options));
