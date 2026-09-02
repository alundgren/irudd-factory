import {
  FactoryError,
  type FactoryErrorCode,
} from "@irudd-factory/application";
import type { ManagedProcess } from "./process.ts";

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

/** Reported whenever a call outlives the client. */
const STOPPED_MESSAGE = "Codex App Server client stopped";

/** How Factory identifies itself to the App Server. */
export const APP_SERVER_CLIENT_NAME = "irudd_factory";

export const REASONING_EFFORT_CONFIG_KEY = "model_reasoning_effort";

export const GITHUB_CONNECTOR_ID = "connector_76869538009648d5b282a4bb21c3d157";
export const CREATE_PULL_REQUEST_TOOL = "create_pull_request";
export const APPROVE_APP_TOOL = "approve";

export interface RpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: FactoryError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
  readonly predicate: (message: RpcMessage) => boolean;
  readonly resolve: (message: RpcMessage) => void;
  readonly reject: (error: FactoryError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class AppServerRpc {
  private readonly child: ManagedProcess;
  private readonly onApproval: (message: RpcMessage) => void;
  private readonly onFailure: (error: FactoryError) => void;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private failure: FactoryError | null = null;
  private processExitExpected = false;
  private outputDrained: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    child: ManagedProcess,
    onApproval: (message: RpcMessage) => void,
    onFailure: (error: FactoryError) => void,
  ) {
    this.child = child;
    this.onApproval = onApproval;
    this.onFailure = onFailure;
  }

  start(): void {
    const stdout = this.readStdout();
    const stderr = drainStream(this.child.process.stderr);
    this.outputDrained = Promise.all([stdout, stderr]).then(() => {});
    void this.child.exited.then((code) => {
      if (!this.stopped && !this.processExitExpected) {
        this.fail(
          new FactoryError({
            code: "provider_exited",
            message: `Codex App Server exited with ${code}`,
          }),
        );
      }
    });
  }

  expectProcessExit(): void {
    if (this.child.hasExited) {
      this.fail(
        new FactoryError({
          code: "provider_exited",
          message: "Codex App Server exited before termination",
        }),
      );
      return;
    }
    this.processExitExpected = true;
  }

  drainOutput(): Promise<void> {
    return this.outputDrained;
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    timeoutCode: FactoryErrorCode,
  ): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stopped) {
      return Promise.reject(
        new FactoryError({
          code: "provider_stopped",
          message: STOPPED_MESSAGE,
        }),
      );
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new FactoryError({
            code: timeoutCode,
            message: `${method} exceeded ${timeoutMs} ms`,
          }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ id, method, params });
    return promise;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  waitFor(
    predicate: (message: RpcMessage) => boolean,
    timeoutMs: number,
    timeoutCode: FactoryErrorCode,
  ): Promise<RpcMessage> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stopped) {
      return Promise.reject(
        new FactoryError({
          code: "provider_stopped",
          message: STOPPED_MESSAGE,
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new FactoryError({
              code: timeoutCode,
              message: `App Server event exceeded ${timeoutMs} ms`,
            }),
          );
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  stop(): void {
    this.stopped = true;
    this.rejectActive(
      new FactoryError({
        code: "provider_stopped",
        message: STOPPED_MESSAGE,
      }),
    );
  }

  private send(message: RpcMessage): void {
    if (this.stopped) return;
    this.child.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async readStdout(): Promise<void> {
    this.child.process.stdout.setEncoding("utf8");
    let buffered = "";
    try {
      for await (const chunk of this.child.process.stdout) {
        buffered += String(chunk);
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) this.handleLine(line);
          newline = buffered.indexOf("\n");
        }
      }
      if (buffered.trim()) this.handleLine(buffered.trim());
    } catch (error) {
      this.fail(
        error instanceof FactoryError
          ? error
          : new FactoryError({
              code: "provider_protocol_error",
              message: "Codex App Server protocol processing failed",
            }),
      );
    }
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.fail(
        new FactoryError({
          code: "provider_protocol_error",
          message: "Codex App Server emitted malformed JSON",
        }),
      );
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new FactoryError({
            code: "provider_rpc_error",
            message: "Codex App Server rejected the request",
          }),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const listener of this.listeners) listener(message);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
    if (
      message.id !== undefined &&
      message.method?.toLowerCase().includes("requestapproval")
    ) {
      this.onApproval(message);
    }
  }

  private fail(error: FactoryError): void {
    if (!this.failure) {
      this.failure = error;
      this.onFailure(error);
    }
    this.rejectActive(this.failure);
  }

  private rejectActive(error: FactoryError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

async function drainStream(stream: NodeJS.ReadableStream): Promise<void> {
  for await (const _chunk of stream) {
    // Reading stderr prevents the child process from blocking on a full pipe.
  }
}
