export const RESULT_NAMES = [
  "completed",
  "rejected",
  "interrupted",
  "provider_exited",
  "protocol_error",
  "model_unavailable",
  "model_rerouted",
  "approval_cancelled",
  "timed_out",
  "assertion_failed",
] as const;

export type ResultName = (typeof RESULT_NAMES)[number];
export type ScenarioName = "read" | "edit" | "pr" | "fail" | "interrupt";

export interface Timeouts {
  childStartupMs: number;
  initializationMs: number;
  modelSchemaMs: number;
  activeEventMs: number;
  approvalMs: number;
  turnMs: number;
  shutdownMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  childStartupMs: 10_000,
  initializationMs: 10_000,
  modelSchemaMs: 20_000,
  activeEventMs: 60_000,
  approvalMs: 120_000,
  turnMs: 600_000,
  shutdownMs: 5_000,
};

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AssertionRecord {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ApprovalRecord {
  method: string;
  requestId: number | string;
  action: string;
  destination?: { host: string; protocol: string; port?: number };
  decision: string;
  timestamp: string;
}

export interface RunManifest {
  runId: string;
  scenario: ScenarioName | "doctor";
  campaignRoot: string;
  runRoot: string;
  workspace: string | null;
  probeManagedPaths: string[];
  sandboxPolicy: unknown;
  remote: string | null;
  repository: string | null;
  startingCommit: string | null;
  requestedModel: "gpt-5.6-luna";
  requestedEffort: "low";
  observedModel: string | null;
  observedEffort: string | null;
  threadSettings: unknown;
  reroutes: unknown[];
  codexVersion: string;
  schemaDigest: string;
  threadId: string | null;
  turnId: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  serializedUtf8Bytes: number;
  itemLifecycles: unknown[];
  tokenUsageUpdates: unknown[];
  approvals: ApprovalRecord[];
  processExit: { code: number | null; signal: string | null } | null;
  result: ResultName;
  effects: Record<string, unknown>;
  assertions: AssertionRecord[];
  timeouts: Timeouts;
}

export class ProbeError extends Error {
  constructor(
    public readonly result: ResultName,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProbeError";
  }
}
