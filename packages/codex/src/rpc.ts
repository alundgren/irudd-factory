import {
  FactoryError,
  type FactoryErrorCode,
} from "@irudd-factory/application";
import type { ManagedProcess } from "./process.ts";

import type { AppServerConnection, RpcMessage } from "./connection.ts";
export * from "./connection.ts";
const STOPPED_MESSAGE = "Codex App Server client stopped";

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

export class AppServerRpc implements AppServerConnection {
  private readonly child: ManagedProcess;
  private readonly failureListeners = new Set<(error: FactoryError) => void>();
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<
    (message: RpcMessage) => void | Promise<void>
  >();
  private failure: FactoryError | null = null;
  private processExitExpected = false;
  private outputDrained: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(child: ManagedProcess) {
    this.child = child;
  }

  onFailure(listener: (error: FactoryError) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failureListeners.delete(listener);
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

  onMessage(
    listener: (message: RpcMessage) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    timeoutCode: FactoryErrorCode,
  ): Promise<unknown> {
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
          if (line) await this.handleLine(line);
          newline = buffered.indexOf("\n");
        }
      }
      if (buffered.trim()) await this.handleLine(buffered.trim());
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

  private async handleLine(line: string): Promise<void> {
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
    for (const listener of this.listeners) await listener(message);
    for (const waiter of this.waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  private fail(error: FactoryError): void {
    if (!this.failure) {
      this.failure = error;
      for (const listener of this.failureListeners) listener(error);
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
