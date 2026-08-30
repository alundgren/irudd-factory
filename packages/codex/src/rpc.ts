import { FactoryError } from "@irudd-factory/application";
import type { ManagedProcess } from "./process.ts";

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
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private stopped = false;

  constructor(
    private readonly child: ManagedProcess,
    private readonly onApproval: (message: RpcMessage) => void,
  ) {}

  start(): void {
    void this.readStdout();
    void new Response(this.child.process.stderr).text();
    void this.child.exited.then((code) => {
      if (!this.stopped) {
        this.fail(
          new FactoryError({
            code: "provider_exited",
            message: `Codex App Server exited with ${code}`,
          }),
        );
      }
    });
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    timeoutCode: string,
  ): Promise<any> {
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
    timeoutCode: string,
  ): Promise<RpcMessage> {
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
    this.fail(
      new FactoryError({
        code: "provider_stopped",
        message: "Codex App Server client stopped",
      }),
    );
  }

  private send(message: RpcMessage): void {
    if (this.stopped) return;
    this.child.process.stdin.write(`${JSON.stringify(message)}\n`);
    this.child.process.stdin.flush();
  }

  private async readStdout(): Promise<void> {
    const reader = this.child.process.stdout
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += value;
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
              message: String(error),
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
            message: message.error.message ?? "Codex RPC failed",
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
