import {
  supportsModel,
  stringAt,
  normalizedItem,
  normalizeTokenUsage,
} from "./protocol-values.ts";
import type {
  ProviderService,
  ProviderTokenUsage,
} from "@irudd-factory/application";
import { FactoryError } from "@irudd-factory/application";
import {
  ASSIGNMENT_EVENTS,
  type RetainedProviderRecord,
} from "@irudd-factory/contracts";
import { Effect } from "effect";
import {
  APPS_CONFIG_KEY,
  APPS_DEFAULT_KEY,
  APP_SERVER_CLIENT_NAME,
  APP_SERVER_METHODS,
  REASONING_EFFORT_CONFIG_KEY,
  type RpcMessage,
  type AppServerConnection,
} from "./connection.ts";

export interface ProtocolTimeouts {
  readonly childStartupMs: number;
  readonly initializationMs: number;
  readonly modelSchemaMs: number;
  readonly turnMs: number;
}

export function createProtocolRun(
  rpc: AppServerConnection,
  input: Parameters<ProviderService["run"]>[0],
  emit: Parameters<ProviderService["run"]>[1],
  retain: Parameters<ProviderService["run"]>[2],
  options: { readonly timeouts: ProtocolTimeouts },
  signal: AbortSignal,
) {
  const model = input.assignment.requestedModel;
  const reasoningEffort = input.assignment.requestedEffort;
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
  const guardTerminal = async <A>(operation: () => Promise<A>): Promise<A> => {
    throwIfTerminal();
    const result = await operation();
    throwIfTerminal();
    return result;
  };
  const raceTerminal = async <A>(operation: () => Promise<A>): Promise<A> => {
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
  const unsubscribeFailure = rpc.onFailure(recordTerminal);
  const unsubscribe = rpc.onMessage(async (message) => {
    if (
      message.id !== undefined &&
      message.method?.toLowerCase().includes("requestapproval")
    ) {
      approvalCount += 1;
      rpc.respond(
        message.id,
        message.method === APP_SERVER_METHODS.itemRequestApproval
          ? { permissions: {} }
          : { decision: "cancel" },
      );
      recordTerminal(
        new FactoryError({
          code: "approval_requested",
          message: `Codex requested approval through ${message.method ?? "unknown"}`,
        }),
      );
    }

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
        stringAt(message.params, "threadSettings", "model") ?? observedModel;
      observedEffort =
        stringAt(message.params, "threadSettings", "effort") ?? observedEffort;
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
      const item = message.params?.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
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
  const snapshot = () => ({
    threadId,
    turnId,
    observedModel,
    observedEffort,
    finalResponse,
    tokenUsage,
    itemSummaries,
    approvalCount,
    reroutes,
    records: retainedRecords,
  });
  return {
    snapshot,
    guardTerminal,
    throwIfTerminal,
    dispose: () => {
      signal.removeEventListener("abort", shutdownRequested);
      unsubscribe();
      unsubscribeFailure();
    },
    run: async () => {
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
            detail: { threadId: activeThreadId },
            patch: {
              state: "running",
              threadId: activeThreadId,
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
      const status = stringAt(completed.params, "turn", "status") ?? "unknown";
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
      return { ...snapshot(), threadId, turnId, observedModel, observedEffort };
    },
  };
}
