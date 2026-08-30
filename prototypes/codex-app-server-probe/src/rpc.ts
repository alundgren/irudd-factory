import type { RunArtifacts } from "./artifacts.ts";
import {
  isApprovalRequest,
  promptForApproval,
  type ApprovalScope,
} from "./approval.ts";
import type { ManagedProcess } from "./process.ts";
import { ProbeError, type ApprovalRecord, type RpcMessage } from "./types.ts";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly fatalListeners = new Set<(error: Error) => void>();
  private readonly approvalControllers = new Map<
    number | string,
    AbortController
  >();
  private stopped = false;
  readonly approvals: ApprovalRecord[] = [];

  constructor(
    private readonly child: ManagedProcess,
    private readonly artifacts: RunArtifacts,
    private readonly scenario: string,
    private readonly approvalMs: number,
    private readonly approvalInput: NodeJS.ReadableStream = process.stdin,
    private readonly approvalOutput: NodeJS.WritableStream = process.stderr,
    private readonly approvalScope?: ApprovalScope,
  ) {}

  start(): void {
    void this.readStdout();
    void this.readStderr();
    void this.child.exited.then((code) => {
      if (!this.stopped) {
        const error = new ProbeError(
          "provider_exited",
          "provider_exited",
          `App Server exited with ${code}`,
        );
        this.abortApprovals(error);
        this.failPending(error);
      }
    });
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<any> {
    const id = this.nextId++;
    const message: RpcMessage = { method, id, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProbeError(
            "timed_out",
            "rpc_timeout",
            `${method} timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send(message);
    return promise;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(
    predicate: (message: RpcMessage) => boolean,
    timeoutMs: number,
    code: string,
  ): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer);
        unsubscribe();
        this.fatalListeners.delete(fail);
        reject(error);
      };
      const unsubscribe = this.onMessage((message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        unsubscribe();
        this.fatalListeners.delete(fail);
        resolve(message);
      });
      this.fatalListeners.add(fail);
      const timer = setTimeout(() => {
        unsubscribe();
        this.fatalListeners.delete(fail);
        reject(
          new ProbeError(
            "timed_out",
            code,
            `Event wait timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
    });
  }

  stop(
    error = new ProbeError(
      "provider_exited",
      "client_stopped",
      "RPC client stopped",
    ),
  ): void {
    this.stopped = true;
    this.abortApprovals(error);
    this.failPending(error);
  }

  private send(message: RpcMessage): void {
    if (this.stopped)
      throw new ProbeError(
        "provider_exited",
        "client_stopped",
        "Cannot write to stopped client",
      );
    this.artifacts.recordRpc("client", message);
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
          if (line) await this.handleLine(line);
          newline = buffered.indexOf("\n");
        }
      }
      if (buffered.trim()) await this.handleLine(buffered.trim());
    } catch (error) {
      this.failPending(
        error instanceof ProbeError
          ? error
          : new ProbeError(
              "protocol_error",
              "stdout_read_failed",
              String(error),
            ),
      );
    }
  }

  private async readStderr(): Promise<void> {
    const text = await new Response(this.child.process.stderr).text();
    if (text) this.artifacts.record("child-stderr", text);
  }

  private async handleLine(line: string): Promise<void> {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      throw new ProbeError(
        "protocol_error",
        "malformed_json",
        `Malformed JSON from App Server: ${line}`,
      );
    }
    this.artifacts.recordRpc("server", message);
    if (message.method === "serverRequest/resolved") {
      const requestId = message.params?.requestId;
      if (typeof requestId === "number" || typeof requestId === "string") {
        this.approvalControllers
          .get(requestId)
          ?.abort(
            new ProbeError(
              "approval_cancelled",
              "approval_resolved",
              "App Server resolved the approval request",
            ),
          );
      }
    }
    if (typeof message.id !== "undefined" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new ProbeError(
            "protocol_error",
            "rpc_error",
            message.error.message ?? "Unknown JSON-RPC error",
            message.error,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const listener of this.listeners) listener(message);
    if (isApprovalRequest(message)) {
      void this.handleApproval(message);
    }
  }

  private async handleApproval(message: RpcMessage): Promise<void> {
    const requestId = message.id!;
    const controller = new AbortController();
    this.approvalControllers.set(requestId, controller);
    try {
      const outcome = await promptForApproval(
        message,
        this.scenario,
        this.approvalMs,
        this.artifacts,
        this.approvalInput,
        this.approvalOutput,
        controller.signal,
        this.approvalScope,
      );
      this.approvals.push(outcome.record);
      this.send({ id: requestId, result: outcome.response });
    } catch (error) {
      const probeError =
        error instanceof ProbeError
          ? error
          : new ProbeError(
              "approval_cancelled",
              "approval_failed",
              String(error),
            );
      const record: ApprovalRecord = {
        method: message.method!,
        requestId,
        action: message.method!,
        decision:
          probeError.code === "approval_resolved"
            ? "cancelled_by_server"
            : probeError.result === "provider_exited"
              ? "provider_exited"
              : `cancelled:${probeError.code}`,
        timestamp: new Date().toISOString(),
      };
      this.approvals.push(record);
      this.artifacts.record("probe", { approval: record });
      if (
        probeError.code === "approval_resolved" ||
        probeError.result === "provider_exited"
      ) {
        return;
      }
      if (!this.stopped) {
        this.send({
          id: requestId,
          result:
            message.method === "item/permissions/requestApproval"
              ? { permissions: {} }
              : { decision: "cancel" },
        });
      }
      this.failPending(probeError);
    } finally {
      this.approvalControllers.delete(requestId);
    }
  }

  private abortApprovals(error: ProbeError): void {
    for (const controller of this.approvalControllers.values())
      controller.abort(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.fatalListeners) listener(error);
    this.fatalListeners.clear();
  }
}
