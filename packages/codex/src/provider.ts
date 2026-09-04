import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  ProviderRunResult,
  ProviderService,
  ProviderTokenUsage,
  TokenUsageBreakdown,
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
import {
  APPS_CONFIG_KEY,
  APPS_DEFAULT_KEY,
  APP_SERVER_CLIENT_NAME,
  APP_SERVER_METHODS,
  AppServerRpc,
  REASONING_EFFORT_CONFIG_KEY,
  type RpcMessage,
} from "./rpc.ts";

export interface ProviderTimeouts {
  readonly childStartupMs: number;
  readonly initializationMs: number;
  readonly modelSchemaMs: number;
  readonly turnMs: number;
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

function supportsModel(
  result: unknown,
  model: string,
  effort: string,
): boolean {
  const data = (result as { data?: unknown })?.data;
  if (!Array.isArray(data)) return false;
  const entry = data.find((value) => {
    const item = value as Record<string, unknown>;
    return item.id === model || item.model === model;
  }) as Record<string, unknown> | undefined;
  if (!entry || !Array.isArray(entry.supportedReasoningEfforts)) return false;
  return entry.supportedReasoningEfforts.some(
    (value) =>
      value === effort ||
      (value as Record<string, unknown>)?.reasoningEffort === effort,
  );
}

function stringAt(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

function normalizedItem(
  message: RpcMessage,
): Readonly<Record<string, unknown>> {
  const item = message.params?.item as Record<string, unknown> | undefined;
  return {
    phase:
      message.method === APP_SERVER_METHODS.itemStarted
        ? "started"
        : "completed",
    ...(typeof item?.id === "string" ? { id: item.id } : {}),
    ...(typeof item?.type === "string" ? { type: item.type } : {}),
    ...(typeof item?.status === "string" ? { status: item.status } : {}),
  };
}

function numericField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    throw new FactoryError({
      code: "provider_protocol_error",
      message: `Codex token usage has an invalid ${key}`,
    });
  }
  return field as number;
}

function tokenBreakdown(value: unknown): TokenUsageBreakdown {
  if (!value || typeof value !== "object") {
    throw new FactoryError({
      code: "provider_protocol_error",
      message: "Codex token usage breakdown is missing",
    });
  }
  const record = value as Readonly<Record<string, unknown>>;
  return {
    inputTokens: numericField(record, "inputTokens"),
    cachedInputTokens: numericField(record, "cachedInputTokens"),
    outputTokens: numericField(record, "outputTokens"),
    reasoningOutputTokens: numericField(record, "reasoningOutputTokens"),
    totalTokens: numericField(record, "totalTokens"),
    ...(record.cacheWriteInputTokens === undefined
      ? {}
      : {
          cacheWriteInputTokens: numericField(record, "cacheWriteInputTokens"),
        }),
  };
}

function normalizeTokenUsage(value: unknown): ProviderTokenUsage {
  if (!value || typeof value !== "object") {
    throw new FactoryError({
      code: "provider_protocol_error",
      message: "Codex token usage is missing",
    });
  }
  const record = value as Readonly<Record<string, unknown>>;
  const contextWindow = record.modelContextWindow;
  if (
    contextWindow !== null &&
    contextWindow !== undefined &&
    (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0)
  ) {
    throw new FactoryError({
      code: "provider_protocol_error",
      message: "Codex token usage has an invalid modelContextWindow",
    });
  }
  return {
    total: tokenBreakdown(record.total),
    last: tokenBreakdown(record.last),
    modelContextWindow:
      contextWindow === undefined ? null : (contextWindow as number | null),
  };
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

export function makeCodexProvider(
  options: CodexProviderOptions,
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
          const model = input.assignment.requestedModel;
          const reasoningEffort = input.assignment.requestedEffort;
          const runtime = resolve(options.runtimeRoot, input.assignment.id);
          const schemaRoot = join(runtime, "schema");
          await mkdir(schemaRoot, { recursive: true });
          const version = await runManagedCommand({
            command: [...prefix, "--version"],
            cwd: input.workspace.worktreePath,
            timeoutMs: options.timeouts.childStartupMs,
            timeoutCode: "child_startup_timeout",
          });
          if (version.code !== 0) {
            throw new FactoryError({
              code: "codex_version_failed",
              message: `codex --version exited with code ${version.code}`,
            });
          }
          const codexVersion = normalizeVersion(version.stdout);
          const schema = await runManagedCommand({
            command: [
              ...prefix,
              "app-server",
              "generate-json-schema",
              "--out",
              schemaRoot,
            ],
            cwd: input.workspace.worktreePath,
            timeoutMs: options.timeouts.modelSchemaMs,
            timeoutCode: "model_schema_timeout",
          });
          if (schema.code !== 0) {
            throw new FactoryError({
              code: "schema_generation_failed",
              message: `App Server schema generation exited with code ${schema.code}`,
            });
          }
          const schemaDigest = await inspectSchemas(schemaRoot);
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
          let threadId: string | null = null;
          let turnId: string | null = null;
          let approvalCount = 0;
          const reroutes: Array<Readonly<Record<string, unknown>>> = [];
          let observedModel: string | null = null;
          let observedEffort: string | null = null;
          let finalResponse = "";
          let tokenUsage: ProviderTokenUsage | null = null;
          const itemSummaries: Array<Readonly<Record<string, unknown>>> = [];
          const retainedRecords: RetainedProviderRecord[] = [];
          const retainRecords = async (
            records: ReadonlyArray<RetainedProviderRecord>,
          ): Promise<void> => {
            if (retain) {
              await Effect.runPromise(retain(records));
            } else {
              retainedRecords.push(...records);
            }
          };
          let terminalFailure: FactoryError | null = null;
          let resolveTerminal!: (error: FactoryError) => void;
          const terminalSignal = new Promise<FactoryError>((resolve) => {
            resolveTerminal = resolve;
          });
          const recordTerminal = (error: FactoryError): void => {
            if (terminalFailure) return;
            terminalFailure = error;
            resolveTerminal(error);
          };
          const throwIfTerminal = (): void => {
            if (terminalFailure) throw terminalFailure;
          };
          const shutdownRequested = (): void =>
            recordTerminal(
              new FactoryError({
                code: "service_shutdown",
                message: "Factory service is shutting down",
              }),
            );
          if (signal.aborted) {
            shutdownRequested();
          } else {
            signal.addEventListener("abort", shutdownRequested, {
              once: true,
            });
          }
          const guardTerminal = async <A>(
            operation: () => Promise<A>,
          ): Promise<A> => {
            throwIfTerminal();
            const result = await operation();
            throwIfTerminal();
            return result;
          };
          const raceTerminal = async <A>(
            operation: () => Promise<A>,
          ): Promise<A> => {
            throwIfTerminal();
            const result = await Promise.race([
              operation(),
              terminalSignal.then((error) => Promise.reject(error)),
            ]);
            throwIfTerminal();
            return result;
          };
          /**
           * Codex multiplexes every thread over the one App Server
           * connection, so a subagent the assignment thread spawns reports its
           * own items and turn completion here. Only the assignment thread
           * describes the run Factory is observing.
           */
          const belongsToAssignmentThread = (message: RpcMessage): boolean => {
            const messageThreadId = stringAt(message.params, "threadId");
            return (
              threadId === null ||
              messageThreadId === null ||
              messageThreadId === threadId
            );
          };
          const rpc = new AppServerRpc(
            child,
            (message) => {
              approvalCount += 1;
              if (message.id !== undefined) {
                rpc.respond(
                  message.id,
                  message.method === APP_SERVER_METHODS.itemRequestApproval
                    ? { permissions: {} }
                    : { decision: "cancel" },
                );
              }
              recordTerminal(
                new FactoryError({
                  code: "approval_requested",
                  message: `Codex requested approval through ${message.method ?? "unknown"}`,
                }),
              );
            },
            recordTerminal,
          );
          const unsubscribe = rpc.onMessage(async (message) => {
            if (!belongsToAssignmentThread(message)) return;
            if (message.method === APP_SERVER_METHODS.modelRerouted) {
              reroutes.push({
                ...(stringAt(message.params, "fromModel")
                  ? { fromModel: stringAt(message.params, "fromModel") }
                  : {}),
                ...(stringAt(message.params, "toModel")
                  ? { toModel: stringAt(message.params, "toModel") }
                  : {}),
                ...(stringAt(message.params, "reason")
                  ? { reason: stringAt(message.params, "reason") }
                  : {}),
              });
              recordTerminal(
                new FactoryError({
                  code: "model_rerouted",
                  message: "Codex rerouted the requested model",
                }),
              );
            }
            if (message.method === APP_SERVER_METHODS.error) {
              recordTerminal(
                new FactoryError({
                  code: "provider_error_notification",
                  message: "Codex emitted an error notification",
                }),
              );
            }
            if (message.method === APP_SERVER_METHODS.threadSettingsUpdated) {
              observedModel =
                stringAt(message.params, "threadSettings", "model") ??
                observedModel;
              observedEffort =
                stringAt(message.params, "threadSettings", "effort") ??
                observedEffort;
            }
            if (
              message.method === APP_SERVER_METHODS.itemStarted ||
              message.method === APP_SERVER_METHODS.itemCompleted
            ) {
              const summary = normalizedItem(message);
              itemSummaries.push(summary);
              await retainRecords([
                {
                  kind: "item",
                  timestamp: new Date().toISOString(),
                  phase: summary.phase === "started" ? "started" : "completed",
                  ...(typeof summary.id === "string" ? { id: summary.id } : {}),
                  ...(typeof summary.type === "string"
                    ? { itemType: summary.type }
                    : {}),
                  ...(typeof summary.status === "string"
                    ? { status: summary.status }
                    : {}),
                },
              ]);
            }
            if (message.method === APP_SERVER_METHODS.itemCompleted) {
              const item = message.params?.item as
                | Record<string, unknown>
                | undefined;
              if (
                item?.type === "agentMessage" &&
                typeof item.text === "string"
              ) {
                finalResponse = item.text;
                await retainRecords([
                  {
                    kind: "transcript",
                    timestamp: new Date().toISOString(),
                    text: item.text,
                  },
                ]);
              }
            }
            if (message.method === APP_SERVER_METHODS.threadTokenUsageUpdated) {
              tokenUsage = normalizeTokenUsage(message.params?.tokenUsage);
              await retainRecords([
                {
                  kind: "usage",
                  timestamp: new Date().toISOString(),
                  usage: tokenUsage,
                },
              ]);
            }
          });
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
            await raceTerminal(() =>
              rpc.request(
                APP_SERVER_METHODS.initialize,
                {
                  clientInfo: {
                    name: APP_SERVER_CLIENT_NAME,
                    title: "Irudd Factory",
                    version: "0.1.0",
                  },
                  capabilities: { experimentalApi: true },
                },
                options.timeouts.childStartupMs,
                "child_startup_timeout",
              ),
            );
            await guardTerminal(async () =>
              rpc.notify(APP_SERVER_METHODS.initialized, {}),
            );
            let models: unknown;
            try {
              models = await raceTerminal(() =>
                rpc.request(
                  APP_SERVER_METHODS.modelList,
                  { limit: 100, includeHidden: true },
                  options.timeouts.modelSchemaMs,
                  "model_schema_timeout",
                ),
              );
            } catch (error) {
              if (
                error instanceof FactoryError &&
                error.code === "provider_rpc_error"
              ) {
                throw new FactoryError({
                  code: "model_unavailable",
                  message: error.message,
                });
              }
              throw error;
            }
            if (!supportsModel(models, model, reasoningEffort)) {
              throw new FactoryError({
                code: "model_or_effort_unavailable",
                message: `${model} with ${reasoningEffort} effort is unavailable`,
              });
            }
            const thread = await raceTerminal(() =>
              rpc.request(
                APP_SERVER_METHODS.threadStart,
                {
                  model: model,
                  cwd: input.workspace.worktreePath,
                  approvalPolicy: "never",
                  sandbox: "workspace-write",
                  serviceName: APP_SERVER_CLIENT_NAME,
                  config: {
                    [REASONING_EFFORT_CONFIG_KEY]: reasoningEffort,
                    [APPS_CONFIG_KEY]: {
                      [APPS_DEFAULT_KEY]: { enabled: false },
                    },
                  },
                },
                options.timeouts.initializationMs,
                "initialization_timeout",
              ),
            );
            threadId = stringAt(thread, "thread", "id");
            observedModel =
              stringAt(thread, "model") ?? stringAt(thread, "thread", "model");
            observedEffort = stringAt(thread, "reasoningEffort");
            if (!threadId) {
              throw new FactoryError({
                code: "thread_id_missing",
                message: "thread/start returned no thread ID",
              });
            }
            const activeThreadId = threadId;
            await guardTerminal(() =>
              Effect.runPromise(
                emit({
                  type: ASSIGNMENT_EVENTS.providerSettingsObserved,
                  timestamp: new Date().toISOString(),
                  detail: {
                    threadId: activeThreadId,
                    ...(observedModel ? { observedModel } : {}),
                    ...(observedEffort ? { observedEffort } : {}),
                  },
                  patch: {
                    threadId: activeThreadId,
                    codexVersion,
                    ...(observedModel ? { observedModel } : {}),
                    ...(observedEffort ? { observedEffort } : {}),
                  },
                }),
              ),
            );
            if (observedModel !== model) {
              throw new FactoryError({
                code: "observed_model_mismatch",
                message: `Requested ${model}, observed ${observedModel ?? "none"}`,
              });
            }
            if (observedEffort !== null && observedEffort !== reasoningEffort) {
              throw new FactoryError({
                code: "observed_effort_mismatch",
                message: `Requested ${reasoningEffort}, observed ${observedEffort}`,
              });
            }
            await guardTerminal(() =>
              Effect.runPromise(
                emit({
                  type: ASSIGNMENT_EVENTS.providerThreadStarted,
                  timestamp: new Date().toISOString(),
                  detail: { threadId: activeThreadId, schemaDigest },
                  patch: {
                    state: "running",
                    threadId: activeThreadId,
                    codexVersion,
                    ...(observedModel ? { observedModel } : {}),
                    ...(observedEffort ? { observedEffort } : {}),
                  },
                }),
              ),
            );
            const completion = raceTerminal(() =>
              rpc.waitFor(
                (message) =>
                  message.method === APP_SERVER_METHODS.turnCompleted &&
                  belongsToAssignmentThread(message),
                options.timeouts.turnMs,
                "turn_completion_timeout",
              ),
            );
            void completion.catch(() => {});
            const turn = await raceTerminal(() =>
              rpc.request(
                APP_SERVER_METHODS.turnStart,
                {
                  threadId: activeThreadId,
                  input: [{ type: "text", text: input.prompt }],
                  cwd: input.workspace.worktreePath,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "workspaceWrite",
                    writableRoots: [
                      input.workspace.worktreePath,
                      input.workspace.worktreeGitDir,
                      input.workspace.commonGitDir,
                    ],
                    networkAccess: true,
                    excludeSlashTmp: true,
                    excludeTmpdirEnvVar: true,
                  },
                  model: model,
                  effort: reasoningEffort,
                },
                options.timeouts.initializationMs,
                "initialization_timeout",
              ),
            );
            turnId = stringAt(turn, "turn", "id");
            if (!turnId) {
              throw new FactoryError({
                code: "turn_id_missing",
                message: "turn/start returned no turn ID",
              });
            }
            const activeTurnId = turnId;
            await guardTerminal(() =>
              Effect.runPromise(
                emit({
                  type: ASSIGNMENT_EVENTS.providerTurnStarted,
                  timestamp: new Date().toISOString(),
                  detail: { turnId: activeTurnId },
                  patch: { turnId: activeTurnId },
                }),
              ),
            );
            const completed = await completion;
            throwIfTerminal();
            if (completed.method === APP_SERVER_METHODS.modelRerouted) {
              throw new FactoryError({
                code: "model_rerouted",
                message: "Codex rerouted the requested model",
              });
            }
            const status =
              stringAt(completed.params, "turn", "status") ?? "unknown";
            if (status !== "completed") {
              throw new FactoryError({
                code: "turn_not_completed",
                message: `Codex turn finished with ${status}`,
              });
            }
            await guardTerminal(() =>
              Effect.runPromise(
                emit({
                  type: ASSIGNMENT_EVENTS.providerSettingsObserved,
                  timestamp: new Date().toISOString(),
                  detail: {
                    ...(observedModel ? { observedModel } : {}),
                    ...(observedEffort ? { observedEffort } : {}),
                  },
                  patch: {
                    ...(observedModel ? { observedModel } : {}),
                    ...(observedEffort ? { observedEffort } : {}),
                  },
                }),
              ),
            );
            if (observedModel !== model) {
              throw new FactoryError({
                code: "observed_model_mismatch",
                message: `Requested ${model}, observed ${observedModel ?? "none"}`,
              });
            }
            if (observedEffort === null) {
              throw new FactoryError({
                code: "observed_effort_missing",
                message: "Codex did not report the observed reasoning effort",
              });
            }
            if (observedEffort !== reasoningEffort) {
              throw new FactoryError({
                code: "observed_effort_mismatch",
                message: `Requested ${reasoningEffort}, observed ${observedEffort}`,
              });
            }
            throwIfTerminal();
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
            await retainRecords([
              {
                kind: "process_exit",
                timestamp: new Date().toISOString(),
                code: processExit.code,
                signal: processExit.signal,
                cleanupTimedOut: processExit.cleanupTimedOut,
              },
            ]);
            const result: ProviderRunResult = {
              codexVersion,
              threadId,
              turnId,
              observedModel,
              observedEffort,
              finalResponse,
              itemSummaries,
              tokenUsage,
              approvalCount,
              processExit: {
                code: processExit.code,
                signal: processExit.signal,
                schemaDigest,
              },
              records: retain ? [] : retainedRecords,
            };
            throwIfTerminal();
            return result;
          } catch (primary) {
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
            signal.removeEventListener("abort", shutdownRequested);
            unsubscribe();
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
