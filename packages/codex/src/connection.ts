import type {
  FactoryError,
  FactoryErrorCode,
} from "@irudd-factory/application";

/**
 * The Codex App Server methods Factory sends or listens for. Requests and the
 * notification handlers that react to them have to name the same method, so
 * the wire vocabulary is written once here.
 */
export const APP_SERVER_METHODS = {
  initialize: "initialize",
  initialized: "initialized",
  modelList: "model/list",
  modelRerouted: "model/rerouted",
  threadStart: "thread/start",
  threadSettingsUpdated: "thread/settings/updated",
  threadTokenUsageUpdated: "thread/tokenUsage/updated",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  turnCompleted: "turn/completed",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  itemRequestApproval: "item/permissions/requestApproval",
  error: "error",
} as const;

/** How Factory identifies itself to the App Server. */
export const APP_SERVER_CLIENT_NAME = "irudd_factory";

export const REASONING_EFFORT_CONFIG_KEY = "model_reasoning_effort";

/**
 * Codex installs a GitHub connector app by default, and its
 * `create_pull_request` tool demands an approval an unattended run has nobody
 * to answer. Factory disables every app at thread start so Codex opens the
 * pull request with `gh` in the sandbox shell instead.
 */
export const APPS_CONFIG_KEY = "apps";
export const APPS_DEFAULT_KEY = "_default";

export interface RpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export interface AppServerConnection {
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    timeoutCode: FactoryErrorCode,
  ): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  respond(id: number | string, result: unknown): void;
  onMessage(
    listener: (message: RpcMessage) => void | Promise<void>,
  ): () => void;
  onFailure(listener: (error: FactoryError) => void): () => void;
  waitFor(
    predicate: (message: RpcMessage) => boolean,
    timeoutMs: number,
    timeoutCode: FactoryErrorCode,
  ): Promise<RpcMessage>;
}
