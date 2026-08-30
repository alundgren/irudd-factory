import { createInterface } from "node:readline/promises";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { RunArtifacts } from "./artifacts.ts";
import { isWithin } from "./paths.ts";
import type { ApprovalRecord, RpcMessage } from "./types.ts";
import { ProbeError } from "./types.ts";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export interface ApprovalOutcome {
  response: unknown;
  record: ApprovalRecord;
}

export interface ApprovalScope {
  workspace: string;
  readableRoots: string[];
  writableRoots: string[];
}

export function isApprovalRequest(message: RpcMessage): boolean {
  return (
    typeof message.id !== "undefined" &&
    Boolean(message.method && APPROVAL_METHODS.has(message.method))
  );
}

function availableDecisions(message: RpcMessage): string[] {
  const supplied = message.params?.availableDecisions;
  if (Array.isArray(supplied))
    return supplied.filter(
      (value): value is string => typeof value === "string",
    );
  if (message.method === "item/permissions/requestApproval")
    return ["accept", "decline", "cancel"];
  return ["accept", "acceptForSession", "decline", "cancel"];
}

function actionDescription(message: RpcMessage): string {
  const params = message.params ?? {};
  const network = params.networkApprovalContext as
    | Record<string, unknown>
    | undefined;
  if (network) {
    return `network ${String(network.protocol ?? "unknown")}://${String(network.host ?? "unknown")}:${String(network.port ?? "default")} in ${String(params.cwd ?? "unknown cwd")}${params.command ? ` for ${String(params.command)}` : ""}${params.reason ? `, reason: ${String(params.reason)}` : ""}`;
  }
  const command = params.command;
  const cwd = params.cwd;
  if (typeof command === "string")
    return `command ${command} in ${String(cwd ?? "unknown cwd")}${params.reason ? `, reason: ${String(params.reason)}` : ""}`;
  if (Array.isArray(command))
    return `command ${command.map(String).join(" ")} in ${String(cwd ?? "unknown cwd")}${params.reason ? `, reason: ${String(params.reason)}` : ""}`;
  const grantRoot = params.grantRoot;
  if (grantRoot)
    return `file change under ${String(grantRoot)}${params.reason ? `, reason: ${String(params.reason)}` : ""}`;
  if (message.method === "item/fileChange/requestApproval")
    return `file change in the scenario workspace${params.reason ? `, reason: ${String(params.reason)}` : ""}`;
  if (message.method === "item/permissions/requestApproval")
    return `permissions in ${String(cwd ?? "unknown cwd")}: ${JSON.stringify(params.permissions ?? {})}${params.reason ? `, reason: ${String(params.reason)}` : ""}`;
  return message.method ?? "approval";
}

async function canonicalAncestor(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      await stat(current);
      return realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function requireAllowedPath(
  candidate: unknown,
  roots: string[],
  label: string,
): Promise<void> {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new ProbeError(
      "approval_cancelled",
      "approval_path_invalid",
      `${label} must be an absolute path`,
    );
  }
  const resolved = resolve(candidate);
  const ancestor = await canonicalAncestor(resolved);
  if (
    !roots.some((root) => isWithin(root, resolved) && isWithin(root, ancestor))
  ) {
    throw new ProbeError(
      "approval_cancelled",
      "approval_path_outside_roots",
      `${label} is outside the allowed roots: ${resolved}`,
    );
  }
}

async function validateFilePermissions(
  fileSystem: Record<string, unknown>,
  scope: ApprovalScope,
): Promise<void> {
  for (const key of ["read", "write"] as const) {
    const values = fileSystem[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      await requireAllowedPath(
        value,
        key === "read" ? scope.readableRoots : scope.writableRoots,
        `${key} permission`,
      );
    }
  }
  const entries = fileSystem.entries;
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const record = entry as Record<string, any>;
    if (record.access === "deny") continue;
    if (record.path?.type !== "path") {
      throw new ProbeError(
        "approval_cancelled",
        "approval_path_unsupported",
        "Glob and special filesystem permission requests are not accepted",
      );
    }
    await requireAllowedPath(
      record.path.path,
      record.access === "write" ? scope.writableRoots : scope.readableRoots,
      `${String(record.access)} permission`,
    );
  }
}

async function validateApproval(
  message: RpcMessage,
  scenario: string,
  scope?: ApprovalScope,
): Promise<void> {
  const params = message.params ?? {};
  const network = params.networkApprovalContext as
    | Record<string, unknown>
    | undefined;
  if (network) {
    if (
      scenario !== "pr" ||
      typeof network.host !== "string" ||
      !network.host ||
      typeof network.protocol !== "string" ||
      !network.protocol
    ) {
      throw new ProbeError(
        "approval_cancelled",
        "network_approval_forbidden",
        "Network approval requires pr and a named host and protocol",
      );
    }
  }
  if (message.method === "item/permissions/requestApproval") {
    const permissions = (params.permissions ?? {}) as Record<string, any>;
    if (permissions.network?.enabled) {
      throw new ProbeError(
        "approval_cancelled",
        "destination_free_network_forbidden",
        "Destination-free network permission requests are never accepted",
      );
    }
    if (scope && permissions.fileSystem)
      await validateFilePermissions(permissions.fileSystem, scope);
  }
  if (!scope) return;
  if (message.method === "item/commandExecution/requestApproval") {
    await requireAllowedPath(params.cwd, [scope.workspace], "command cwd");
    const additional = params.additionalPermissions as
      | Record<string, any>
      | undefined;
    if (additional?.network?.enabled && !network) {
      throw new ProbeError(
        "approval_cancelled",
        "destination_free_network_forbidden",
        "Command requested network access without a named destination",
      );
    }
    if (additional?.fileSystem)
      await validateFilePermissions(additional.fileSystem, scope);
  }
  if (
    message.method === "item/fileChange/requestApproval" &&
    params.grantRoot != null
  ) {
    await requireAllowedPath(
      params.grantRoot,
      scope.writableRoots,
      "file grant root",
    );
  }
}

export async function promptForApproval(
  message: RpcMessage,
  scenario: string,
  timeoutMs: number,
  artifacts: RunArtifacts,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
  signal?: AbortSignal,
  scope?: ApprovalScope,
): Promise<ApprovalOutcome> {
  const decisions = availableDecisions(message);
  await validateApproval(message, scenario, scope);
  const action = artifacts.redactText(actionDescription(message));
  output.write(
    `Approval requested: ${action}\nAvailable decisions: ${decisions.join(", ")}\nDecision: `,
  );
  const reader = createInterface({
    input,
    output,
    terminal: Boolean((input as NodeJS.ReadStream).isTTY),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const inputEnded = new Promise<string>((_, reject) => {
      reader.once("close", () =>
        reject(
          new ProbeError(
            "approval_cancelled",
            "approval_eof",
            `Approval input ended for ${action}`,
          ),
        ),
      );
      reader.once("SIGINT", () =>
        reject(
          new ProbeError(
            "approval_cancelled",
            "approval_interrupted",
            `Approval interrupted for ${action}`,
          ),
        ),
      );
    });
    const cancelled = new Promise<string>((_, reject) => {
      if (!signal) return;
      const rejectCancelled = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new ProbeError(
                "approval_cancelled",
                "approval_resolved",
                `Approval resolved for ${action}`,
              ),
        );
      if (signal.aborted) rejectCancelled();
      else signal.addEventListener("abort", rejectCancelled, { once: true });
    });
    const answer = await Promise.race([
      reader.question(""),
      inputEnded,
      cancelled,
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProbeError(
                "approval_cancelled",
                "approval_timeout",
                `Approval timed out for ${action}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    const decision = answer.trim();
    if (!decision) {
      throw new ProbeError(
        "approval_cancelled",
        "approval_eof",
        `Approval input ended for ${action}`,
      );
    }
    if (
      !decisions.includes(decision) ||
      !["accept", "acceptForSession", "decline", "cancel"].includes(decision)
    ) {
      throw new ProbeError(
        "approval_cancelled",
        "approval_invalid",
        `Unavailable approval decision: ${decision}`,
      );
    }
    if (
      scenario !== "pr" &&
      decision.startsWith("accept") &&
      message.params?.networkApprovalContext
    ) {
      throw new ProbeError(
        "approval_cancelled",
        "network_forbidden",
        "Network approvals are allowed only for pr",
      );
    }
    const network = message.params?.networkApprovalContext as
      | Record<string, unknown>
      | undefined;
    const record: ApprovalRecord = {
      method: message.method!,
      requestId: message.id!,
      action,
      decision,
      timestamp: new Date().toISOString(),
      ...(network
        ? {
            destination: {
              host: String(network.host ?? "unknown"),
              protocol: String(network.protocol ?? "unknown"),
              ...(typeof network.port === "number"
                ? { port: network.port }
                : {}),
            },
          }
        : {}),
    };
    artifacts.record("probe", { approval: record });
    if (message.method === "item/permissions/requestApproval") {
      const requested = message.params?.permissions;
      return {
        response: decision.startsWith("accept")
          ? { permissions: requested ?? {}, scope: "turn" }
          : { permissions: {} },
        record,
      };
    }
    return { response: { decision }, record };
  } finally {
    if (timer) clearTimeout(timer);
    reader.close();
  }
}
