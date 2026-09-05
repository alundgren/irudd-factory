import {
  FactoryError,
  type FactoryErrorCode,
} from "@irudd-factory/application";
import type { AppServerConnection, RpcMessage } from "../../src/connection.ts";
import { protocolScenario } from "./protocol-scenario.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: FactoryError) => void;
  timeoutCode: FactoryErrorCode;
};
type Waiter = {
  predicate: (message: RpcMessage) => boolean;
  resolve: (message: RpcMessage) => void;
  reject: (error: FactoryError) => void;
  timeoutCode: FactoryErrorCode;
};

export class InMemoryConnection implements AppServerConnection {
  readonly sent: RpcMessage[] = [];
  readonly messages: RpcMessage[] = [];
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<
    (message: RpcMessage) => void | Promise<void>
  >();
  private readonly failureListeners = new Set<(error: FactoryError) => void>();
  private failure: FactoryError | null = null;
  private readonly handle: (message: RpcMessage) => Promise<void>;
  private delivery = Promise.resolve();

  constructor(mode = "success") {
    this.handle = protocolScenario(mode, (message) => {
      this.messages.push(message);
    });
  }

  onMessage(listener: (message: RpcMessage) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: FactoryError) => void) {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failureListeners.delete(listener);
  }

  request(
    method: string,
    params: Record<string, unknown>,
    _timeoutMs: number,
    timeoutCode: FactoryErrorCode,
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const message = { id: this.nextId++, method, params };
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(message.id, { resolve, reject, timeoutCode }),
    );
    this.sent.push(message);
    this.delivery = this.delivery
      .then(async () => {
        await this.handle(message);
        await this.flush();
      })
      .catch((error: unknown) =>
        this.fail(
          error instanceof FactoryError
            ? error
            : new FactoryError({
                code: "provider_protocol_error",
                message: "In-memory delivery failed",
              }),
        ),
      );
    return result;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.sent.push({ method, params });
  }
  respond(id: number | string, result: unknown): void {
    this.sent.push({ id, result });
  }

  waitFor(
    predicate: (message: RpcMessage) => boolean,
    _timeoutMs: number,
    timeoutCode: FactoryErrorCode,
  ): Promise<RpcMessage> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) =>
      this.waiters.add({ predicate, resolve, reject, timeoutCode }),
    );
  }

  async receive(message: RpcMessage): Promise<void> {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error)
        pending?.reject(
          new FactoryError({
            code: "provider_rpc_error",
            message: "Codex App Server rejected the request",
          }),
        );
      else pending?.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) await listener(message);
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  private async flush(): Promise<void> {
    while (this.messages.length) await this.receive(this.messages.shift()!);
  }

  expireRequests(): void {
    for (const pending of this.pending.values())
      pending.reject(
        new FactoryError({
          code: pending.timeoutCode,
          message: "Deterministic request timeout",
        }),
      );
    this.pending.clear();
  }

  expireWaiters(): void {
    for (const waiter of this.waiters)
      waiter.reject(
        new FactoryError({
          code: waiter.timeoutCode,
          message: "Deterministic waiter timeout",
        }),
      );
    this.waiters.clear();
  }

  fail(error: FactoryError): void {
    this.failure ??= error;
    for (const listener of this.failureListeners) listener(this.failure);
    for (const pending of this.pending.values()) pending.reject(this.failure);
    for (const waiter of this.waiters) waiter.reject(this.failure);
    this.pending.clear();
    this.waiters.clear();
  }

  async dispose(): Promise<void> {
    this.fail(
      new FactoryError({
        code: "provider_stopped",
        message: "In-memory connection stopped",
      }),
    );
    await this.delivery;
    this.listeners.clear();
    this.failureListeners.clear();
  }

  get activeCount(): number {
    return (
      this.pending.size +
      this.waiters.size +
      this.listeners.size +
      this.failureListeners.size
    );
  }
}
