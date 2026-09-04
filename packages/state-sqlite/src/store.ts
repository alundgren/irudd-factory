import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AdmissionInput,
  AssignmentPatch,
  AdmissionResult,
  QueueObservationInput,
  StateStoreService,
  LifecycleCommandInput,
} from "@irudd-factory/application";
import { FactoryError, StateStore } from "@irudd-factory/application";
import {
  ACTIVE_ASSIGNMENT_STATES,
  Assignment,
  AssignmentState,
  AssignmentEvent,
  ASSIGNMENT_EVENTS,
  AttemptUsage,
  type CommandReceipt,
  CommandResult,
  type DispatchState,
  type QueueEntry,
  DEFAULT_PAGE_LIMIT,
  type EventPage,
  IssueRef,
  MAX_PAGE_LIMIT,
  NormalizedError,
  type Page,
  type PageRequest,
  PullRequest,
  RETAINED_TEXT_TRUNCATION_MARKER,
  type RetainedProviderRecord,
  RetainedProviderEvent,
  TranscriptEntry,
  WorkspacePaths,
  LifecycleAdmission,
  LifecycleCommand,
  LifecycleCommandKind,
  LifecycleCommandPhase,
  LifecycleConsequence,
} from "@irudd-factory/contracts";
import { Effect, Layer, Schema } from "effect";
import { migrate } from "./migrations.ts";
import { sqlStateList } from "./sql.ts";

interface AssignmentRow {
  readonly id: string;
  readonly provider: string;
  readonly issue_node_id: string;
  readonly issue_repository: string;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly issue_title: string;
  readonly state: Assignment["state"];
  readonly starting_commit: string;
  readonly workflow_blob_id: string;
  readonly workflow_digest: string;
  readonly workflow_body: string;
  readonly workspace_json: string | null;
  readonly requested_model: string;
  readonly requested_effort: string;
  readonly observed_model: string | null;
  readonly observed_effort: string | null;
  readonly codex_version: string | null;
  readonly thread_id: string | null;
  readonly turn_id: string | null;
  readonly process_group_id: number | null;
  readonly process_start_identity: string | null;
  readonly process_start_pending: number;
  readonly pull_request_json: string | null;
  readonly error_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_event_sequence: number;
  readonly archived_at: string | null;
}

interface LifecycleCommandRow {
  readonly command_id: string;
  readonly kind: string;
  readonly target_attempt_id: string;
  readonly expected_target_version: number;
  readonly phase: string;
  readonly effect: string;
  readonly admission_json: string;
  readonly consequence_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EventRow {
  readonly sequence: number;
  readonly assignment_id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly detail_json: string;
}

interface ReceiptRow {
  readonly command_id: string;
  readonly result_json: string;
  readonly created_at: string;
}

interface QueueTenureRow {
  readonly id: string;
  readonly issue_node_id: string;
  readonly issue_repository: string;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly issue_title: string;
  readonly starting_commit: string;
  readonly workflow_blob_id: string;
  readonly workflow_digest: string;
  readonly workflow_body: string;
  readonly eligible_since: string;
  readonly last_observed_at: string;
  readonly ended_at: string | null;
  readonly reason_code: string | null;
  readonly reason_message: string | null;
}

interface DispatchStateRow {
  readonly paused: number;
  readonly codex_enabled: number;
  readonly updated_at: string;
}

interface IssueQueueStatusRow {
  readonly issue_node_id: string;
  readonly eligible: number;
}

interface TranscriptRow {
  readonly sequence: number;
  readonly attempt_id: string;
  readonly timestamp: string;
  readonly role: "agent";
  readonly text: string;
  readonly truncated: number;
}

interface ProviderEventRow {
  readonly sequence: number;
  readonly attempt_id: string;
  readonly timestamp: string;
  readonly type: RetainedProviderEvent["type"];
  readonly detail_json: string;
}

interface UsageRow {
  readonly attempt_id: string;
  readonly timestamp: string;
  readonly total_json: string;
  readonly last_json: string;
  readonly model_context_window: number | null;
}

function storageError(error: unknown): FactoryError {
  return error instanceof FactoryError
    ? error
    : new FactoryError({
        code: "state_store_failed",
        message: String(error),
      });
}

function decodeJson<A, I>(schema: Schema.Schema<A, I>, source: string): A {
  return Schema.decodeUnknownSync(schema)(JSON.parse(source) as unknown);
}

function decodeJsonOrNull<A, I>(
  schema: Schema.Schema<A, I>,
  source: string | null,
): A | null {
  return source === null ? null : decodeJson(schema, source);
}

function decodeAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    provider: row.provider,
    issue: {
      nodeId: row.issue_node_id,
      repository: row.issue_repository,
      number: row.issue_number,
      url: row.issue_url,
      title: row.issue_title,
    },
    state: Schema.decodeUnknownSync(AssignmentState)(row.state),
    workflow: {
      startingCommit: row.starting_commit,
      blobId: row.workflow_blob_id,
      digest: row.workflow_digest,
      body: row.workflow_body,
    },
    workspace: decodeJsonOrNull(WorkspacePaths, row.workspace_json),
    requestedModel: row.requested_model,
    requestedEffort: row.requested_effort,
    observedModel: row.observed_model,
    observedEffort: row.observed_effort,
    codexVersion: row.codex_version,
    threadId: row.thread_id,
    turnId: row.turn_id,
    processGroupId: row.process_group_id,
    processStartIdentity: row.process_start_identity,
    processStartPending: row.process_start_pending === 1,
    pullRequest: decodeJsonOrNull(PullRequest, row.pull_request_json),
    error: decodeJsonOrNull(NormalizedError, row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventSequence: row.last_event_sequence,
    archivedAt: row.archived_at,
  };
}

function decodeLifecycleCommand(row: LifecycleCommandRow): LifecycleCommand {
  return {
    commandId: row.command_id,
    kind: Schema.decodeUnknownSync(LifecycleCommandKind)(row.kind),
    targetAttemptId: row.target_attempt_id,
    expectedTargetVersion: row.expected_target_version,
    phase: Schema.decodeUnknownSync(LifecycleCommandPhase)(row.phase),
    effect: row.effect,
    admission: decodeJson(LifecycleAdmission, row.admission_json),
    consequence: decodeJsonOrNull(LifecycleConsequence, row.consequence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeEvent(row: EventRow): AssignmentEvent {
  return {
    sequence: row.sequence,
    assignmentId: row.assignment_id,
    type: row.type,
    timestamp: row.timestamp,
    detail: decodeJson(AssignmentEvent.fields.detail, row.detail_json),
  };
}

function decodeReceipt(row: ReceiptRow): CommandReceipt {
  return {
    commandId: row.command_id,
    result: decodeJson(CommandResult, row.result_json),
    createdAt: row.created_at,
  };
}

function decodeQueueEntry(row: QueueTenureRow): QueueEntry {
  return {
    tenureId: row.id,
    issue: {
      nodeId: row.issue_node_id,
      repository: row.issue_repository,
      number: row.issue_number,
      url: row.issue_url,
      title: row.issue_title,
    },
    eligibleSince: row.eligible_since,
    lastObservedAt: row.last_observed_at,
    endedAt: row.ended_at,
    startable: row.ended_at === null,
    reason:
      row.reason_code && row.reason_message
        ? { code: row.reason_code, message: row.reason_message }
        : null,
  };
}

function decodeDispatchState(row: DispatchStateRow): DispatchState {
  return {
    paused: row.paused === 1,
    codexEnabled: row.codex_enabled === 1,
    updatedAt: row.updated_at,
  };
}

function decodeTranscript(row: TranscriptRow): TranscriptEntry {
  return {
    sequence: row.sequence,
    attemptId: row.attempt_id,
    timestamp: row.timestamp,
    role: row.role,
    text: row.text,
    truncated: row.truncated === 1,
  };
}

function decodeProviderEvent(row: ProviderEventRow): RetainedProviderEvent {
  return {
    sequence: row.sequence,
    attemptId: row.attempt_id,
    timestamp: row.timestamp,
    type: row.type,
    detail: decodeJson(RetainedProviderEvent.fields.detail, row.detail_json),
  };
}

function decodeUsage(row: UsageRow): AttemptUsage {
  return {
    attemptId: row.attempt_id,
    timestamp: row.timestamp,
    total: decodeJson(AttemptUsage.fields.total, row.total_json),
    last: decodeJson(AttemptUsage.fields.last, row.last_json),
    modelContextWindow: row.model_context_window,
  };
}

export interface OpenStateStore {
  readonly database: DatabaseSync;
  readonly service: StateStoreService;
  readonly close: () => void;
}

export interface StateStoreOptions {
  readonly recover?: boolean;
  readonly sensitivePatterns?: ReadonlyArray<string>;
  readonly maxTextBytes?: number;
}

interface DatabaseLease {
  readonly release: () => void;
}

const RECOVERY_TERM_WAIT_MS = 250;
const RECOVERY_EXIT_CONFIRM_MS = 5_000;
const RECOVERY_POLL_MS = 10;
const recoveryWait = new Int32Array(new SharedArrayBuffer(4));

function canonicalDatabasePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  }
}

function processStartIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    const startTime = fields[19];
    return startTime ? `${pid}:${startTime}` : null;
  } catch {
    return null;
  }
}

function waitForStoredProcessExit(
  pid: number,
  identity: string,
  milliseconds: number,
): boolean {
  const deadline = Date.now() + milliseconds;
  while (
    processStartIdentity(pid) === identity ||
    processGroupHasLiveMembers(pid)
  ) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    Atomics.wait(recoveryWait, 0, 0, Math.min(RECOVERY_POLL_MS, remaining));
  }
  return true;
}

function processGroupHasLiveMembers(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === processGroupId && fields[0] !== "Z") {
        return true;
      }
    } catch {
      // The process may exit between listing /proc and reading its stat file.
    }
  }
  return false;
}

function acquireDatabaseLease(path: string): DatabaseLease {
  const lockPath = `${path}.lock`;
  const identity =
    processStartIdentity(process.pid) ?? `${process.pid}:unknown`;
  const token = JSON.stringify({ pid: process.pid, identity });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, token, "utf8");
      } finally {
        closeSync(descriptor);
      }
      return {
        release: () => {
          try {
            if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
          } catch {
            // A missing or replaced lock no longer belongs to this process.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const existing = JSON.parse(readFileSync(lockPath, "utf8")) as {
          readonly pid?: unknown;
          readonly identity?: unknown;
        };
        if (
          typeof existing.pid === "number" &&
          typeof existing.identity === "string" &&
          processStartIdentity(existing.pid) === existing.identity
        ) {
          throw new FactoryError({
            code: "database_in_use",
            message: `Another Factory service owns ${path}`,
          });
        }
        unlinkSync(lockPath);
      } catch (readError) {
        if (readError instanceof FactoryError) throw readError;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs < 5_000) {
            throw new FactoryError({
              code: "database_in_use",
              message: `Another Factory service is acquiring ${path}`,
            });
          }
        } catch (statError) {
          if (statError instanceof FactoryError) throw statError;
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // Another contender may already have replaced the stale lock.
        }
      }
    }
  }
  throw new FactoryError({
    code: "database_in_use",
    message: `Could not acquire the lifetime lease for ${path}`,
  });
}

export function openStateStore(
  path: string,
  options: StateStoreOptions = {},
): OpenStateStore {
  const maxTextBytes = options.maxTextBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 256) {
    throw new FactoryError({
      code: "retention_config_invalid",
      message: "maxTextBytes must be an integer of at least 256 bytes",
    });
  }
  let sensitivePatterns: ReadonlyArray<RegExp>;
  try {
    sensitivePatterns = (options.sensitivePatterns ?? []).map(
      (pattern) => new RegExp(pattern, "gu"),
    );
  } catch (error) {
    throw new FactoryError({
      code: "retention_config_invalid",
      message: "A retained-text redaction pattern is invalid",
      detail: String(error),
    });
  }
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const databasePath = canonicalDatabasePath(path);
  const lease = acquireDatabaseLease(databasePath);
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { timeout: 5_000 });
  } catch (error) {
    lease.release();
    throw error;
  }
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  try {
    migrate(database);
  } catch (error) {
    database.close();
    lease.release();
    throw error;
  }

  const receiptQuery = database.prepare(
    "SELECT command_id, result_json, created_at FROM command_receipts WHERE command_id = $commandId",
  );
  const assignmentQuery = database.prepare(
    "SELECT * FROM assignments WHERE id = $id",
  );
  const lifecycleCommandQuery = database.prepare(
    "SELECT * FROM lifecycle_commands WHERE command_id = $commandId",
  );

  function retainText(source: string): { text: string; truncated: boolean } {
    let text = source;
    for (const pattern of sensitivePatterns)
      text = text.replace(pattern, "[redacted]");
    if (Buffer.byteLength(text, "utf8") <= maxTextBytes) {
      return { text, truncated: false };
    }
    const available =
      maxTextBytes - Buffer.byteLength(RETAINED_TEXT_TRUNCATION_MARKER);
    let retained = Buffer.from(text, "utf8")
      .subarray(0, available)
      .toString("utf8");
    while (
      Buffer.byteLength(retained + RETAINED_TEXT_TRUNCATION_MARKER) >
      maxTextBytes
    ) {
      retained = retained.slice(0, -1);
    }
    return {
      text: `${retained}${RETAINED_TEXT_TRUNCATION_MARKER}`,
      truncated: true,
    };
  }

  function shortText(source: unknown): string | undefined {
    return typeof source === "string" ? retainText(source).text : undefined;
  }

  function projectEventDetail(
    type: string,
    source: unknown,
  ): Record<string, unknown> {
    const detail =
      source && typeof source === "object"
        ? (source as Record<string, unknown>)
        : {};
    switch (type) {
      case ASSIGNMENT_EVENTS.workspaceCreated:
        return shortText(detail.branch)
          ? { branch: shortText(detail.branch) }
          : {};
      case ASSIGNMENT_EVENTS.providerProcessStarted:
        return {
          ...(typeof detail.pid === "number" ? { pid: detail.pid } : {}),
          ...(shortText(detail.processStartIdentity)
            ? { processStartIdentity: shortText(detail.processStartIdentity) }
            : {}),
          ...(shortText(detail.schemaDigest)
            ? { schemaDigest: shortText(detail.schemaDigest) }
            : {}),
        };
      case ASSIGNMENT_EVENTS.providerSettingsObserved:
        return {
          ...(shortText(detail.threadId)
            ? { threadId: shortText(detail.threadId) }
            : {}),
          ...(shortText(detail.observedModel)
            ? { observedModel: shortText(detail.observedModel) }
            : {}),
          ...(shortText(detail.observedEffort)
            ? { observedEffort: shortText(detail.observedEffort) }
            : {}),
        };
      case ASSIGNMENT_EVENTS.providerThreadStarted:
        return {
          ...(shortText(detail.threadId)
            ? { threadId: shortText(detail.threadId) }
            : {}),
          ...(shortText(detail.schemaDigest)
            ? { schemaDigest: shortText(detail.schemaDigest) }
            : {}),
        };
      case ASSIGNMENT_EVENTS.providerTurnStarted:
        return shortText(detail.turnId)
          ? { turnId: shortText(detail.turnId) }
          : {};
      case ASSIGNMENT_EVENTS.providerFailed:
      case ASSIGNMENT_EVENTS.failed:
        return {
          ...(shortText(detail.code) ? { code: shortText(detail.code) } : {}),
          ...(shortText(detail.message)
            ? { message: shortText(detail.message) }
            : {}),
        };
      case ASSIGNMENT_EVENTS.completed:
        return {
          ...(shortText(detail.pullRequestUrl)
            ? { pullRequestUrl: shortText(detail.pullRequestUrl) }
            : {}),
          ...(typeof detail.draft === "boolean" ? { draft: detail.draft } : {}),
        };
      case ASSIGNMENT_EVENTS.pullRequestReconciled:
        return {
          ...(shortText(detail.evidence)
            ? { evidence: shortText(detail.evidence) }
            : {}),
          ...(shortText(detail.pullRequestUrl)
            ? { pullRequestUrl: shortText(detail.pullRequestUrl) }
            : {}),
        };
      case ASSIGNMENT_EVENTS.pullRequestLookupStarted:
        return {};
      case ASSIGNMENT_EVENTS.interrupted:
        return shortText(detail.processReconciliation)
          ? { processReconciliation: shortText(detail.processReconciliation) }
          : {};
      case ASSIGNMENT_EVENTS.stopped:
      case ASSIGNMENT_EVENTS.stopUncertain:
      case ASSIGNMENT_EVENTS.returned:
      case ASSIGNMENT_EVENTS.restarted:
      case ASSIGNMENT_EVENTS.archived:
      case ASSIGNMENT_EVENTS.restored:
        return {
          ...(shortText(detail.commandId)
            ? { commandId: shortText(detail.commandId) }
            : {}),
          ...(shortText(detail.processResult)
            ? { processResult: shortText(detail.processResult) }
            : {}),
          ...(shortText(detail.siblingAttemptId)
            ? { siblingAttemptId: shortText(detail.siblingAttemptId) }
            : {}),
        };
      default:
        return {};
    }
  }

  function getReceiptSync(commandId: string) {
    const row = receiptQuery.get({ commandId }) as ReceiptRow | undefined;
    return row ? decodeReceipt(row) : null;
  }

  function insertReceipt(
    commandId: string,
    result: CommandResult,
    timestamp: string,
  ): CommandReceipt {
    database
      .prepare(
        `INSERT INTO command_receipts(command_id, result_json, created_at)
         VALUES ($commandId, $resultJson, $createdAt)`,
      )
      .run({
        commandId,
        resultJson: JSON.stringify(result),
        createdAt: timestamp,
      });
    return { commandId, result, createdAt: timestamp };
  }

  function insertAssignment(value: Assignment): void {
    database
      .prepare(
        `INSERT INTO issues(node_id, repository, number, url, title, created_at, updated_at)
       VALUES ($nodeId, $repository, $number, $url, $title, $createdAt, $updatedAt)
       ON CONFLICT(node_id) DO UPDATE SET
         repository = excluded.repository,
         number = excluded.number,
         url = excluded.url,
         title = excluded.title,
         updated_at = excluded.updated_at`,
      )
      .run({
        nodeId: value.issue.nodeId,
        repository: value.issue.repository,
        number: value.issue.number,
        url: value.issue.url,
        title: value.issue.title,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      });
    database
      .prepare(
        `INSERT INTO assignments(
          id, provider, issue_node_id, issue_repository, issue_number,
          issue_url, issue_title, state, starting_commit, workflow_blob_id,
          workflow_digest, workflow_body, workspace_json, requested_model,
          requested_effort, observed_model, observed_effort, codex_version,
          thread_id, turn_id, process_group_id, process_start_identity,
          process_start_pending,
          pull_request_json, error_json, created_at,
          updated_at, last_event_sequence, archived_at
        ) VALUES (
          $id, $provider, $issueNodeId, $issueRepository, $issueNumber,
          $issueUrl, $issueTitle, $state, $startingCommit, $workflowBlobId,
          $workflowDigest, $workflowBody, $workspaceJson, $requestedModel,
          $requestedEffort, $observedModel, $observedEffort, $codexVersion,
          $threadId, $turnId, $processGroupId, $processStartIdentity,
          $processStartPending,
          $pullRequestJson, $errorJson, $createdAt,
          $updatedAt, $lastEventSequence, $archivedAt
        )`,
      )
      .run({
        id: value.id,
        provider: value.provider,
        issueNodeId: value.issue.nodeId,
        issueRepository: value.issue.repository,
        issueNumber: value.issue.number,
        issueUrl: value.issue.url,
        issueTitle: value.issue.title,
        state: value.state,
        startingCommit: value.workflow.startingCommit,
        workflowBlobId: value.workflow.blobId,
        workflowDigest: value.workflow.digest,
        workflowBody: value.workflow.body,
        workspaceJson: value.workspace ? JSON.stringify(value.workspace) : null,
        requestedModel: value.requestedModel,
        requestedEffort: value.requestedEffort,
        observedModel: value.observedModel,
        observedEffort: value.observedEffort,
        codexVersion: value.codexVersion,
        threadId: value.threadId,
        turnId: value.turnId,
        processGroupId: value.processGroupId ?? null,
        processStartIdentity: value.processStartIdentity ?? null,
        processStartPending: value.processStartPending ? 1 : 0,
        pullRequestJson: value.pullRequest
          ? JSON.stringify(value.pullRequest)
          : null,
        errorJson: value.error ? JSON.stringify(value.error) : null,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        lastEventSequence: value.lastEventSequence,
        archivedAt: value.archivedAt ?? null,
      });
  }

  function insertEvent(
    assignmentId: string,
    type: string,
    timestamp: string,
    detail: unknown,
  ): number {
    const result = database
      .prepare(
        `INSERT INTO assignment_events(assignment_id, type, timestamp, detail_json)
         VALUES ($assignmentId, $type, $timestamp, $detailJson)`,
      )
      .run({
        assignmentId,
        type,
        timestamp,
        detailJson: JSON.stringify(projectEventDetail(type, detail)),
      });
    return Number(result.lastInsertRowid);
  }

  function setLastEventSequence(assignmentId: string, sequence: number): void {
    database
      .prepare(
        "UPDATE assignments SET last_event_sequence = $sequence WHERE id = $id",
      )
      .run({ sequence, id: assignmentId });
  }

  function recordQueueVersion(row: QueueTenureRow): void {
    database
      .prepare(
        `INSERT INTO queue_tenure_versions(
           tenure_id, issue_node_id, issue_repository, issue_number,
           issue_url, issue_title, starting_commit, workflow_blob_id,
           workflow_digest, workflow_body, eligible_since, last_observed_at,
           ended_at, reason_code, reason_message
         ) VALUES (
           $tenureId, $issueNodeId, $issueRepository, $issueNumber,
           $issueUrl, $issueTitle, $startingCommit, $workflowBlobId,
           $workflowDigest, $workflowBody, $eligibleSince, $lastObservedAt,
           $endedAt, $reasonCode, $reasonMessage
         )`,
      )
      .run({
        tenureId: row.id,
        issueNodeId: row.issue_node_id,
        issueRepository: row.issue_repository,
        issueNumber: row.issue_number,
        issueUrl: row.issue_url,
        issueTitle: row.issue_title,
        startingCommit: row.starting_commit,
        workflowBlobId: row.workflow_blob_id,
        workflowDigest: row.workflow_digest,
        workflowBody: row.workflow_body,
        eligibleSince: row.eligible_since,
        lastObservedAt: row.last_observed_at,
        endedAt: row.ended_at,
        reasonCode: row.reason_code,
        reasonMessage: row.reason_message,
      });
  }

  function endTenure(
    tenureId: string,
    timestamp: string,
    code: string,
    message: string,
  ): boolean {
    const changed =
      database
        .prepare(
          `UPDATE queue_tenures
           SET ended_at = $endedAt,
               last_observed_at = $lastObservedAt,
               reason_code = $reasonCode,
               reason_message = $reasonMessage
           WHERE id = $id AND ended_at IS NULL`,
        )
        .run({
          endedAt: timestamp,
          lastObservedAt: timestamp,
          reasonCode: code,
          reasonMessage: message,
          id: tenureId,
        }).changes > 0;
    if (changed) {
      const row = database
        .prepare("SELECT * FROM queue_tenures WHERE id = $id")
        .get({ id: tenureId }) as QueueTenureRow | undefined;
      if (!row) {
        throw new FactoryError({
          code: "state_store_failed",
          message: `Queue tenure ${tenureId} disappeared after update`,
        });
      }
      recordQueueVersion(row);
    }
    return changed;
  }

  function recordEligibilityLoss(
    assignmentId: string,
    issueNodeId: string,
    timestamp: string,
    code: string,
    message: string,
  ): void {
    database
      .prepare(
        `INSERT INTO issue_eligibility_observations(
           assignment_id, issue_node_id, observed_at, eligible,
           reason_code, reason_message
         ) VALUES (
           $assignmentId, $issueNodeId, $observedAt, 0,
           $reasonCode, $reasonMessage
         )`,
      )
      .run({
        assignmentId,
        issueNodeId,
        observedAt: timestamp,
        reasonCode: code,
        reasonMessage: message,
      });
  }

  function recordActiveEligibilityLosses(
    issueNodeId: string,
    timestamp: string,
    code: string,
    message: string,
  ): void {
    const assignments = database
      .prepare(
        `SELECT id FROM assignments
         WHERE issue_node_id = $issueNodeId
           AND state IN (${sqlStateList(ACTIVE_ASSIGNMENT_STATES)})`,
      )
      .all({ issueNodeId }) as unknown as ReadonlyArray<{
      readonly id: string;
    }>;
    for (const assignment of assignments) {
      recordEligibilityLoss(
        assignment.id,
        issueNodeId,
        timestamp,
        code,
        message,
      );
    }
  }

  function setIssueQueueStatus(
    issueNodeId: string,
    repository: string,
    eligible: boolean,
    timestamp: string,
  ): void {
    database
      .prepare(
        `INSERT INTO issue_queue_status(
           issue_node_id, issue_repository, eligible, observed_at
         ) VALUES ($issueNodeId, $repository, $eligible, $observedAt)
         ON CONFLICT(issue_node_id) DO UPDATE SET
           issue_repository = excluded.issue_repository,
           eligible = excluded.eligible,
           observed_at = excluded.observed_at`,
      )
      .run({
        issueNodeId,
        repository,
        eligible: eligible ? 1 : 0,
        observedAt: timestamp,
      });
  }

  function reconcileQueueSync(input: QueueObservationInput): void {
    immediateTransaction(database, () => {
      const repository = input.repository.toLowerCase();
      const currentRows = database
        .prepare(
          `SELECT * FROM queue_tenures
           WHERE issue_repository = $repository AND ended_at IS NULL`,
        )
        .all({
          repository,
        }) as unknown as ReadonlyArray<QueueTenureRow>;
      const currentByNode = new Map(
        currentRows.map((row) => [row.issue_node_id, row]),
      );
      const priorStatuses = database
        .prepare(
          `SELECT issue_node_id, eligible FROM issue_queue_status
           WHERE issue_repository = $repository`,
        )
        .all({ repository }) as unknown as ReadonlyArray<IssueQueueStatusRow>;
      const priorStatusByNode = new Map(
        priorStatuses.map((row) => [row.issue_node_id, row.eligible]),
      );
      const observedNodes = new Set(
        input.candidates.map(({ candidate }) => candidate.issue.nodeId),
      );
      const newlyIneligibleNodes = new Set<string>();

      for (const row of currentRows) {
        if (!observedNodes.has(row.issue_node_id)) {
          endTenure(
            row.id,
            input.timestamp,
            "no_longer_eligible",
            "GitHub no longer reports this issue as eligible",
          );
        }
      }
      for (const status of priorStatuses) {
        if (status.eligible === 1 && !observedNodes.has(status.issue_node_id)) {
          setIssueQueueStatus(
            status.issue_node_id,
            repository,
            false,
            input.timestamp,
          );
          newlyIneligibleNodes.add(status.issue_node_id);
        }
      }

      const update = database.prepare(
        `UPDATE queue_tenures SET
           issue_url = $issueUrl,
           issue_title = $issueTitle,
           starting_commit = $startingCommit,
           workflow_blob_id = $workflowBlobId,
           workflow_digest = $workflowDigest,
           workflow_body = $workflowBody,
           last_observed_at = $lastObservedAt
         WHERE id = $id AND ended_at IS NULL`,
      );
      const insert = database.prepare(
        `INSERT INTO queue_tenures(
           id, issue_node_id, issue_repository, issue_number, issue_url,
           issue_title, starting_commit, workflow_blob_id, workflow_digest,
           workflow_body, eligible_since, last_observed_at
         ) VALUES (
           $id, $issueNodeId, $issueRepository, $issueNumber, $issueUrl,
           $issueTitle, $startingCommit, $workflowBlobId, $workflowDigest,
           $workflowBody, $eligibleSince, $lastObservedAt
         )`,
      );
      const activeAssignmentQuery = database.prepare(
        `SELECT 1 AS present FROM assignments
         WHERE issue_node_id = $issueNodeId
           AND state IN (${sqlStateList(ACTIVE_ASSIGNMENT_STATES)})
         LIMIT 1`,
      );
      const returnedAttemptQuery = database.prepare(
        `SELECT 1 AS present
         FROM assignments
         JOIN assignment_events
           ON assignment_events.assignment_id = assignments.id
         WHERE assignments.issue_node_id = $issueNodeId
           AND assignment_events.type = $returnedEventType
           AND assignments.id = (
             SELECT latest.id FROM assignments AS latest
             WHERE latest.issue_node_id = $issueNodeId
             ORDER BY latest.created_at DESC, latest.rowid DESC
             LIMIT 1
           )
         LIMIT 1`,
      );
      for (const { candidate, tenureId } of input.candidates) {
        const issue = candidate.issue;
        const workflow = candidate.workflow;
        const current = currentByNode.get(issue.nodeId);
        if (current) {
          update.run({
            issueUrl: issue.url,
            issueTitle: issue.title,
            startingCommit: workflow.startingCommit,
            workflowBlobId: workflow.blobId,
            workflowDigest: workflow.digest,
            workflowBody: workflow.body,
            lastObservedAt: input.timestamp,
            id: current.id,
          });
          const updated = database
            .prepare("SELECT * FROM queue_tenures WHERE id = $id")
            .get({ id: current.id }) as QueueTenureRow | undefined;
          if (!updated) {
            throw new FactoryError({
              code: "state_store_failed",
              message: `Queue tenure ${current.id} disappeared after observation`,
            });
          }
          recordQueueVersion(updated);
        } else if (
          priorStatusByNode.get(issue.nodeId) !== 1 ||
          (!activeAssignmentQuery.get({ issueNodeId: issue.nodeId }) &&
            returnedAttemptQuery.get({
              issueNodeId: issue.nodeId,
              returnedEventType: ASSIGNMENT_EVENTS.returned,
            }))
        ) {
          const id = tenureId ?? `tenure-${randomUUID()}`;
          insert.run({
            id,
            issueNodeId: issue.nodeId,
            issueRepository: repository,
            issueNumber: issue.number,
            issueUrl: issue.url,
            issueTitle: issue.title,
            startingCommit: workflow.startingCommit,
            workflowBlobId: workflow.blobId,
            workflowDigest: workflow.digest,
            workflowBody: workflow.body,
            eligibleSince: input.timestamp,
            lastObservedAt: input.timestamp,
          });
          const created = database
            .prepare("SELECT * FROM queue_tenures WHERE id = $id")
            .get({ id }) as QueueTenureRow | undefined;
          if (!created) {
            throw new FactoryError({
              code: "state_store_failed",
              message: `Queue tenure ${id} disappeared after creation`,
            });
          }
          recordQueueVersion(created);
        }
        setIssueQueueStatus(issue.nodeId, repository, true, input.timestamp);
      }

      for (const issueNodeId of newlyIneligibleNodes) {
        recordActiveEligibilityLosses(
          issueNodeId,
          input.timestamp,
          "no_longer_eligible",
          "GitHub no longer reports this active issue as eligible",
        );
      }
    });
  }

  function dispatchStateSync(): DispatchState {
    const row = database
      .prepare(
        "SELECT paused, codex_enabled, updated_at FROM dispatch_state WHERE singleton = 1",
      )
      .get() as DispatchStateRow | undefined;
    if (!row) {
      throw new FactoryError({
        code: "state_store_failed",
        message: "Dispatch state is missing",
      });
    }
    return decodeDispatchState(row);
  }

  function listQueueSync(input: {
    readonly limit: number;
    readonly cursor?: string;
    readonly watermark?: string;
  }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new FactoryError({
        code: "queue_page_invalid",
        message: "Queue page limit must be an integer from 1 through 100",
      });
    }
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FactoryError({
        code: "queue_page_invalid",
        message: "Queue cursor is invalid",
      });
    }
    if (offset > 0 && !input.watermark) {
      throw new FactoryError({
        code: "queue_page_invalid",
        message: "Queue cursor requires its page watermark",
      });
    }
    let revision: number;
    if (input.watermark) {
      const match = /^queue-(0|[1-9][0-9]*)$/.exec(input.watermark);
      revision = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(revision)) {
        throw new FactoryError({
          code: "queue_page_invalid",
          message: "Queue watermark is invalid",
        });
      }
      const latest = database
        .prepare("SELECT max(revision) AS revision FROM queue_tenure_versions")
        .get() as { readonly revision: number | null };
      if (revision > (latest.revision ?? 0)) {
        throw new FactoryError({
          code: "queue_page_invalid",
          message: "Queue watermark is invalid",
        });
      }
    } else {
      const latest = database
        .prepare("SELECT max(revision) AS revision FROM queue_tenure_versions")
        .get() as { readonly revision: number | null };
      revision = latest.revision ?? 0;
    }
    const rows = database
      .prepare(
        `WITH latest AS (
           SELECT tenure_id, max(revision) AS revision
           FROM queue_tenure_versions
           WHERE revision <= $watermark
           GROUP BY tenure_id
         )
         SELECT
           version.tenure_id AS id,
           version.issue_node_id,
           version.issue_repository,
           version.issue_number,
           version.issue_url,
           version.issue_title,
           version.starting_commit,
           version.workflow_blob_id,
           version.workflow_digest,
           version.workflow_body,
           version.eligible_since,
           version.last_observed_at,
           version.ended_at,
           version.reason_code,
           version.reason_message
         FROM latest
         JOIN queue_tenure_versions AS version
           ON version.revision = latest.revision
         WHERE version.ended_at IS NULL OR version.reason_code != 'admitted'
         ORDER BY
           CASE WHEN version.ended_at IS NULL THEN 0 ELSE 1 END,
           CASE WHEN version.ended_at IS NULL THEN version.eligible_since END ASC,
           CASE WHEN version.ended_at IS NULL THEN version.issue_repository END ASC,
           CASE WHEN version.ended_at IS NULL THEN version.issue_number END ASC,
           CASE WHEN version.ended_at IS NULL THEN version.issue_node_id END ASC,
           CASE WHEN version.ended_at IS NULL THEN version.tenure_id END ASC,
           version.ended_at DESC,
           version.tenure_id ASC
         LIMIT $limit OFFSET $offset`,
      )
      .all({
        watermark: revision,
        limit: input.limit + 1,
        offset,
      }) as unknown as ReadonlyArray<QueueTenureRow>;
    const entries = rows.map(decodeQueueEntry);
    const items = entries.slice(0, input.limit);
    const nextOffset = offset + items.length;
    return {
      items,
      watermark: `queue-${revision}`,
      nextCursor: entries.length > input.limit ? String(nextOffset) : null,
    };
  }

  function admitSync(input: AdmissionInput): AdmissionResult {
    return immediateTransaction(database, () => {
      const existing = getReceiptSync(input.commandId);
      if (existing) return { receipt: existing, created: false };

      const controls = dispatchStateSync();
      if (controls.paused) {
        throw new FactoryError({
          code: "dispatch_paused",
          message: "Dispatch is paused",
        });
      }
      if (!controls.codexEnabled) {
        throw new FactoryError({
          code: "codex_disabled",
          message: "Codex is disabled",
        });
      }

      if (input.queueTenureId) {
        const tenure = database
          .prepare(
            `SELECT issue_node_id FROM queue_tenures
             WHERE id = $id AND ended_at IS NULL`,
          )
          .get({ id: input.queueTenureId }) as
          | { readonly issue_node_id: string }
          | undefined;
        if (
          !tenure ||
          !input.candidates.some(
            ({ issue }) => issue.nodeId === tenure.issue_node_id,
          )
        ) {
          return {
            receipt: insertReceipt(
              input.commandId,
              { _tag: "no_candidate" },
              input.timestamp,
            ),
            created: true,
          };
        }
      }

      const activeRows = database
        .prepare(
          `SELECT * FROM assignments
             WHERE provider = $provider
               AND state IN (${sqlStateList(ACTIVE_ASSIGNMENT_STATES)})
             ORDER BY rowid`,
        )
        .all({
          provider: input.provider,
        }) as unknown as ReadonlyArray<AssignmentRow>;
      if (activeRows.length >= (input.slots ?? 1)) {
        const activeRow = activeRows[0]!;
        const result: CommandResult = {
          _tag: "provider_busy",
          assignment: decodeAssignment(activeRow),
        };
        return {
          receipt:
            input.source === "automatic"
              ? {
                  commandId: input.commandId,
                  result,
                  createdAt: input.timestamp,
                }
              : insertReceipt(input.commandId, result, input.timestamp),
          created: true,
        };
      }

      const seenIssueQuery = database.prepare(
        input.allowRetry
          ? `SELECT 1 AS present FROM assignments
             WHERE issue_node_id = $issueNodeId
               AND state IN (${sqlStateList(ACTIVE_ASSIGNMENT_STATES)}) LIMIT 1`
          : "SELECT 1 AS present FROM assignments WHERE issue_node_id = $issueNodeId LIMIT 1",
      );
      const unseen = input.candidates.filter(
        (candidate) =>
          !seenIssueQuery.get({ issueNodeId: candidate.issue.nodeId }),
      );
      if (unseen.length === 0) {
        return {
          receipt: insertReceipt(
            input.commandId,
            { _tag: "no_candidate" },
            input.timestamp,
          ),
          created: true,
        };
      }
      if (unseen.length > 1) {
        return {
          receipt: insertReceipt(
            input.commandId,
            {
              _tag: "selection_ambiguous",
              issueLinks: unseen.map(({ issue }) => issue.url),
            },
            input.timestamp,
          ),
          created: true,
        };
      }

      const candidate = unseen[0];
      if (!candidate) {
        throw new FactoryError({
          code: "admission_invariant_failed",
          message: "Admission selected no candidate",
        });
      }
      const value: Assignment = {
        id: input.assignmentId,
        provider: input.provider,
        issue: candidate.issue,
        state: "reserved",
        workflow: candidate.workflow,
        workspace: null,
        requestedModel: candidate.requestedModel,
        requestedEffort: candidate.requestedEffort,
        observedModel: null,
        observedEffort: null,
        codexVersion: null,
        threadId: null,
        turnId: null,
        processGroupId: null,
        processStartIdentity: null,
        processStartPending: false,
        pullRequest: null,
        error: null,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
        lastEventSequence: 0,
      };
      insertAssignment(value);
      setIssueQueueStatus(
        candidate.issue.nodeId,
        candidate.issue.repository.toLowerCase(),
        true,
        input.timestamp,
      );
      if (input.queueTenureId) {
        const ended = endTenure(
          input.queueTenureId,
          input.timestamp,
          "admitted",
          "Factory reserved this issue for an attempt",
        );
        if (!ended) {
          throw new FactoryError({
            code: "admission_invariant_failed",
            message: `Queue tenure ${input.queueTenureId} was not active during admission`,
          });
        }
      }
      const sequence = insertEvent(
        value.id,
        ASSIGNMENT_EVENTS.reserved,
        input.timestamp,
        {},
      );
      setLastEventSequence(value.id, sequence);
      const assignment = { ...value, lastEventSequence: sequence };
      return {
        receipt: insertReceipt(
          input.commandId,
          { _tag: "started", assignment },
          input.timestamp,
        ),
        created: true,
      };
    });
  }

  function appendEventSync(
    assignmentId: string,
    event: Omit<AssignmentEvent, "sequence" | "assignmentId">,
    patch: AssignmentPatch = {},
  ): Assignment {
    return immediateTransaction(database, () => {
      const currentRow = assignmentQuery.get({ id: assignmentId }) as
        | AssignmentRow
        | undefined;
      if (!currentRow) {
        throw new FactoryError({
          code: "assignment_not_found",
          message: `Assignment ${assignmentId} was not found`,
        });
      }
      const current = decodeAssignment(currentRow);
      const next: Assignment = {
        ...current,
        ...patch,
        ...(patch.error
          ? {
              error: {
                code: retainText(patch.error.code).text,
                message: retainText(patch.error.message).text,
                ...(patch.error.stage
                  ? { stage: retainText(patch.error.stage).text }
                  : {}),
                ...(patch.error.detail
                  ? { detail: retainText(patch.error.detail).text }
                  : {}),
              },
            }
          : {}),
        updatedAt: event.timestamp,
      };
      const sequence = insertEvent(
        assignmentId,
        event.type,
        event.timestamp,
        event.detail,
      );
      database
        .prepare(
          `UPDATE assignments SET
               state = $state,
               workspace_json = $workspaceJson,
               observed_model = $observedModel,
               observed_effort = $observedEffort,
               codex_version = $codexVersion,
               thread_id = $threadId,
               turn_id = $turnId,
               process_group_id = $processGroupId,
               process_start_identity = $processStartIdentity,
               process_start_pending = $processStartPending,
               pull_request_json = $pullRequestJson,
               error_json = $errorJson,
               archived_at = $archivedAt,
               updated_at = $updatedAt,
               last_event_sequence = $lastEventSequence
             WHERE id = $id`,
        )
        .run({
          state: next.state,
          workspaceJson: next.workspace ? JSON.stringify(next.workspace) : null,
          observedModel: next.observedModel,
          observedEffort: next.observedEffort,
          codexVersion: next.codexVersion,
          threadId: next.threadId,
          turnId: next.turnId,
          processGroupId: next.processGroupId ?? null,
          processStartIdentity: next.processStartIdentity ?? null,
          processStartPending: next.processStartPending ? 1 : 0,
          pullRequestJson: next.pullRequest
            ? JSON.stringify(next.pullRequest)
            : null,
          errorJson: next.error ? JSON.stringify(next.error) : null,
          archivedAt: next.archivedAt ?? null,
          updatedAt: next.updatedAt,
          lastEventSequence: sequence,
          id: assignmentId,
        });
      return { ...next, lastEventSequence: sequence };
    });
  }

  function getLifecycleCommandSync(commandId: string): LifecycleCommand | null {
    const row = lifecycleCommandQuery.get({ commandId }) as
      | LifecycleCommandRow
      | undefined;
    return row ? decodeLifecycleCommand(row) : null;
  }

  function beginLifecycleCommandSync(input: LifecycleCommandInput): {
    command: LifecycleCommand;
    created: boolean;
  } {
    return immediateTransaction(database, () => {
      const existing = getLifecycleCommandSync(input.commandId);
      if (existing) return { command: existing, created: false };
      if (!input.commandId.trim()) {
        throw new FactoryError({
          code: "command_id_required",
          message: "commandId must be a nonempty string",
        });
      }
      const row = assignmentQuery.get({ id: input.targetAttemptId }) as
        | AssignmentRow
        | undefined;
      const assignment = row ? decodeAssignment(row) : null;
      let rejection: { code: string; message: string } | null = null;
      if (!assignment) {
        rejection = {
          code: "assignment_not_found",
          message: `Assignment ${input.targetAttemptId} was not found`,
        };
      } else if (assignment.lastEventSequence !== input.expectedTargetVersion) {
        rejection = {
          code: "target_version_changed",
          message: `Attempt ${assignment.id} is at version ${assignment.lastEventSequence}`,
        };
      } else if (
        (input.kind === "return" || input.kind === "restart") &&
        !input.repositoryConfigured
      ) {
        rejection = {
          code: "repository_not_configured",
          message: `Repository ${assignment.issue.repository} is not configured`,
        };
      } else if (
        (input.kind === "return" || input.kind === "restart") &&
        assignment.pullRequest
      ) {
        rejection = {
          code: "pull_request_present",
          message: `Attempt ${assignment.id} already has a pull request`,
        };
      } else {
        const allowed =
          input.kind === "stop"
            ? [
                "reserved",
                "starting",
                "running",
                "ownership_uncertain",
                "stop_uncertain",
              ].includes(assignment.state) && !assignment.archivedAt
            : input.kind === "return" || input.kind === "restart"
              ? ["failed", "interrupted", "stopped"].includes(
                  assignment.state,
                ) && !assignment.archivedAt
              : input.kind === "archive"
                ? ["completed", "failed", "interrupted", "stopped"].includes(
                    assignment.state,
                  ) && !assignment.archivedAt
                : ["completed", "failed", "interrupted", "stopped"].includes(
                    assignment.state,
                  ) && Boolean(assignment.archivedAt);
        if (!allowed) {
          rejection = {
            code: "lifecycle_state_invalid",
            message: `${input.kind} is not allowed for attempt ${assignment.id} in state ${assignment.state}`,
          };
        }
      }
      const admission = rejection
        ? ({ _tag: "rejected", ...rejection } as const)
        : ({
            _tag: "accepted",
            sourceState: assignment!.state,
            sourceVersion: assignment!.lastEventSequence,
          } as const);
      const consequence = rejection
        ? ({ _tag: "rejected", ...rejection } as const)
        : null;
      database
        .prepare(
          `INSERT INTO lifecycle_commands(
             command_id, kind, target_attempt_id, expected_target_version,
             phase, effect, admission_json, consequence_json, created_at, updated_at
           ) VALUES (
             $commandId, $kind, $targetAttemptId, $expectedTargetVersion,
             $phase, $effect, $admissionJson, $consequenceJson, $createdAt, $updatedAt
           )`,
        )
        .run({
          commandId: input.commandId,
          kind: input.kind,
          targetAttemptId: input.targetAttemptId,
          expectedTargetVersion: input.expectedTargetVersion,
          phase: rejection ? "final" : "accepted",
          effect: rejection ? "none" : "admitted",
          admissionJson: JSON.stringify(admission),
          consequenceJson: consequence ? JSON.stringify(consequence) : null,
          createdAt: input.timestamp,
          updatedAt: input.timestamp,
        });
      return {
        command: getLifecycleCommandSync(input.commandId)!,
        created: true,
      };
    });
  }

  function markLifecycleCommandExecutingSync(
    commandId: string,
    effect: string,
    timestamp: string,
  ): LifecycleCommand {
    return immediateTransaction(database, () => {
      const current = getLifecycleCommandSync(commandId);
      if (!current) {
        throw new FactoryError({
          code: "state_store_failed",
          message: `Lifecycle command ${commandId} was not found`,
        });
      }
      if (current.phase === "final") return current;
      database
        .prepare(
          `UPDATE lifecycle_commands
           SET phase = $phase, effect = $effect, updated_at = $updatedAt
           WHERE command_id = $commandId`,
        )
        .run({ phase: "executing", effect, updatedAt: timestamp, commandId });
      return getLifecycleCommandSync(commandId)!;
    });
  }

  function finishLifecycleCommandSync(
    commandId: string,
    consequence: LifecycleConsequence,
    timestamp: string,
    patch: AssignmentPatch = {},
  ): LifecycleCommand {
    const current = getLifecycleCommandSync(commandId);
    if (!current) {
      throw new FactoryError({
        code: "state_store_failed",
        message: `Lifecycle command ${commandId} was not found`,
      });
    }
    if (current.phase === "final") return current;
    const eventType = {
      stopped: ASSIGNMENT_EVENTS.stopped,
      stop_uncertain: ASSIGNMENT_EVENTS.stopUncertain,
      returned: ASSIGNMENT_EVENTS.returned,
      restarted: ASSIGNMENT_EVENTS.restarted,
      archived: ASSIGNMENT_EVENTS.archived,
      restored: ASSIGNMENT_EVENTS.restored,
      rejected: null,
    }[consequence._tag];
    if (eventType) {
      const recorded = database
        .prepare(
          `SELECT 1 AS present FROM assignment_events
           WHERE assignment_id = $assignmentId AND type = $type
             AND json_extract(detail_json, '$.commandId') = $commandId
           LIMIT 1`,
        )
        .get({
          assignmentId: current.targetAttemptId,
          type: eventType,
          commandId,
        });
      if (!recorded) {
        appendEventSync(
          current.targetAttemptId,
          {
            type: eventType,
            timestamp,
            detail: {
              commandId,
              ...(consequence._tag === "stopped"
                ? { processResult: consequence.processResult }
                : {}),
              ...(consequence._tag === "restarted"
                ? { siblingAttemptId: consequence.siblingAttemptId }
                : {}),
            },
          },
          patch,
        );
      }
    }
    return immediateTransaction(database, () => {
      database
        .prepare(
          `UPDATE lifecycle_commands
           SET phase = $phase, effect = $effect,
               consequence_json = $consequenceJson, updated_at = $updatedAt
           WHERE command_id = $commandId`,
        )
        .run({
          phase: "final",
          effect: "complete",
          consequenceJson: JSON.stringify(consequence),
          updatedAt: timestamp,
          commandId,
        });
      return getLifecycleCommandSync(commandId)!;
    });
  }

  function reconcileStoredProcess(identity: {
    readonly processGroupId: number;
    readonly processStartIdentity: string;
  }): "exited" | "terminated" | "uncertain" {
    const current = processStartIdentity(identity.processGroupId);
    if (current === null || current !== identity.processStartIdentity) {
      return processGroupHasLiveMembers(identity.processGroupId)
        ? "uncertain"
        : "exited";
    }
    try {
      process.kill(-identity.processGroupId, "SIGTERM");
      if (
        waitForStoredProcessExit(
          identity.processGroupId,
          identity.processStartIdentity,
          RECOVERY_TERM_WAIT_MS,
        )
      ) {
        return "terminated";
      }
      process.kill(-identity.processGroupId, "SIGKILL");
      return waitForStoredProcessExit(
        identity.processGroupId,
        identity.processStartIdentity,
        RECOVERY_EXIT_CONFIRM_MS - RECOVERY_TERM_WAIT_MS,
      )
        ? "terminated"
        : "uncertain";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? "exited"
        : "uncertain";
    }
  }

  function reconcileAttemptProcessSync(
    attemptId: string,
  ): "exited" | "terminated" | "uncertain" {
    const row = assignmentQuery.get({ id: attemptId }) as
      | AssignmentRow
      | undefined;
    if (!row) {
      throw new FactoryError({
        code: "assignment_not_found",
        message: `Assignment ${attemptId} was not found`,
      });
    }
    const assignment = decodeAssignment(row);
    if (
      assignment.processGroupId != null &&
      assignment.processStartIdentity != null
    ) {
      return reconcileStoredProcess({
        processGroupId: assignment.processGroupId,
        processStartIdentity: assignment.processStartIdentity,
      });
    }
    return assignment.processStartPending ? "uncertain" : "exited";
  }

  function interruptUnfinishedSync(
    timestamp: string,
    reconcileProcess: (identity: {
      readonly processGroupId: number;
      readonly processStartIdentity: string;
    }) => "exited" | "terminated" | "uncertain",
  ): void {
    const rows = database
      .prepare(
        `SELECT * FROM assignments
         WHERE state IN (${sqlStateList(ACTIVE_ASSIGNMENT_STATES)})
         ORDER BY rowid`,
      )
      .all() as unknown as ReadonlyArray<AssignmentRow>;
    for (const row of rows) {
      const assignment = decodeAssignment(row);
      const outcome =
        assignment.processGroupId != null &&
        assignment.processStartIdentity != null
          ? reconcileProcess({
              processGroupId: assignment.processGroupId,
              processStartIdentity: assignment.processStartIdentity,
            })
          : assignment.processStartPending
            ? "uncertain"
            : "exited";
      const uncertain = outcome === "uncertain";
      const uncertainState =
        assignment.state === "stop_uncertain"
          ? "stop_uncertain"
          : "ownership_uncertain";
      appendEventSync(
        assignment.id,
        {
          type: ASSIGNMENT_EVENTS.interrupted,
          timestamp,
          detail: { processReconciliation: outcome },
        },
        {
          state: uncertain ? uncertainState : "interrupted",
          error: {
            code: uncertain ? "process_identity_changed" : "service_shutdown",
            message: uncertain
              ? "Provider process ownership could not be confirmed"
              : "Factory interrupted this attempt during startup recovery",
          },
        },
      );
    }
  }

  function appendProviderRecordsSync(
    attemptId: string,
    records: ReadonlyArray<RetainedProviderRecord>,
  ): void {
    const tokenBreakdown = (
      value: RetainedProviderRecord & { kind: "usage" },
      which: "total" | "last",
    ) => {
      const source = value.usage[which];
      for (const field of [
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "totalTokens",
      ] as const) {
        if (!Number.isSafeInteger(source[field]) || source[field] < 0) {
          throw new FactoryError({
            code: "retained_record_invalid",
            message: `Provider usage has an invalid ${field}`,
          });
        }
      }
      return {
        inputTokens: source.inputTokens,
        cachedInputTokens: source.cachedInputTokens,
        outputTokens: source.outputTokens,
        reasoningOutputTokens: source.reasoningOutputTokens,
        totalTokens: source.totalTokens,
        ...(source.cacheWriteInputTokens === undefined
          ? {}
          : { cacheWriteInputTokens: source.cacheWriteInputTokens }),
      };
    };
    immediateTransaction(database, () => {
      if (!assignmentQuery.get({ id: attemptId })) {
        throw new FactoryError({
          code: "assignment_not_found",
          message: `Assignment ${attemptId} was not found`,
        });
      }
      for (const record of records) {
        if (record.kind === "transcript") {
          const retained = retainText(record.text);
          database
            .prepare(
              `INSERT INTO attempt_transcript(attempt_id, timestamp, role, text, truncated)
             VALUES ($attemptId, $timestamp, $role, $text, $truncated)`,
            )
            .run({
              attemptId,
              timestamp: record.timestamp,
              role: "agent",
              text: retained.text,
              truncated: retained.truncated ? 1 : 0,
            });
          continue;
        }
        let type: RetainedProviderEvent["type"];
        let detail: Record<string, unknown>;
        if (record.kind === "item") {
          type = record.phase === "started" ? "item.started" : "item.completed";
          detail = {
            ...(record.id ? { id: retainText(record.id).text } : {}),
            ...(record.itemType
              ? { itemType: retainText(record.itemType).text }
              : {}),
            ...(record.status
              ? { status: retainText(record.status).text }
              : {}),
          };
        } else if (record.kind === "usage") {
          type = "usage.updated";
          detail = {};
          const total = tokenBreakdown(record, "total");
          const last = tokenBreakdown(record, "last");
          database
            .prepare(
              `INSERT INTO attempt_usage(attempt_id, timestamp, total_json, last_json, model_context_window)
             VALUES ($attemptId, $timestamp, $totalJson, $lastJson, $modelContextWindow)
             ON CONFLICT(attempt_id) DO UPDATE SET
               timestamp = excluded.timestamp,
               total_json = excluded.total_json,
               last_json = excluded.last_json,
               model_context_window = excluded.model_context_window`,
            )
            .run({
              attemptId,
              timestamp: record.timestamp,
              totalJson: JSON.stringify(total),
              lastJson: JSON.stringify(last),
              modelContextWindow: record.usage.modelContextWindow,
            });
        } else if (record.kind === "error") {
          type = "provider.error";
          detail = {
            code: retainText(record.code).text,
            message: retainText(record.message).text,
          };
        } else {
          type = "process.exited";
          detail = {
            code: record.code,
            signal: record.signal,
            cleanupTimedOut: record.cleanupTimedOut,
          };
        }
        database
          .prepare(
            `INSERT INTO retained_provider_events(attempt_id, timestamp, type, detail_json)
           VALUES ($attemptId, $timestamp, $type, $detailJson)`,
          )
          .run({
            attemptId,
            timestamp: record.timestamp,
            type,
            detailJson: JSON.stringify(detail),
          });
      }
    });
  }

  function pageRequest<A>(
    kind: string,
    scope: string,
    request: PageRequest,
    schema: Schema.Schema<A>,
    load: () => ReadonlyArray<A>,
  ): Page<A> {
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
    const cursor = request.cursor ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new FactoryError({
        code: "page_invalid",
        message: `limit must be from 1 through ${MAX_PAGE_LIMIT}`,
      });
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new FactoryError({
        code: "page_invalid",
        message: "cursor must be a nonnegative integer",
      });
    }
    let watermark = request.watermark;
    let values: ReadonlyArray<A>;
    if (watermark) {
      const row = database
        .prepare(
          "SELECT kind, scope, values_json FROM read_snapshots WHERE watermark = $watermark",
        )
        .get({ watermark }) as
        | { kind: string; scope: string; values_json: string }
        | undefined;
      if (!row || row.kind !== kind || row.scope !== scope) {
        throw new FactoryError({
          code: "page_watermark_invalid",
          message: "The page watermark does not match this read",
        });
      }
      values = decodeJson(Schema.Array(schema), row.values_json);
    } else {
      watermark = randomUUID();
      values = load();
      database
        .prepare(
          `INSERT INTO read_snapshots(watermark, kind, scope, values_json, created_at)
         VALUES ($watermark, $kind, $scope, $valuesJson, $createdAt)`,
        )
        .run({
          watermark,
          kind,
          scope,
          valuesJson: JSON.stringify(values),
          createdAt: new Date().toISOString(),
        });
    }
    const items = values.slice(cursor, cursor + limit);
    const next = cursor + items.length;
    return { items, nextCursor: next < values.length ? next : null, watermark };
  }

  function issueRows(): ReadonlyArray<typeof IssueRef.Type> {
    return (
      database
        .prepare(
          "SELECT node_id, repository, number, url, title FROM issues ORDER BY created_at, repository, number, node_id",
        )
        .all() as unknown as ReadonlyArray<{
        node_id: string;
        repository: string;
        number: number;
        url: string;
        title: string;
      }>
    ).map((row) => ({
      nodeId: row.node_id,
      repository: row.repository,
      number: row.number,
      url: row.url,
      title: row.title,
    }));
  }

  function assignmentRows(
    order: "history" | "timeline",
  ): ReadonlyArray<Assignment> {
    const direction = order === "history" ? "DESC" : "ASC";
    return (
      database
        .prepare(
          `SELECT * FROM assignments
           WHERE archived_at IS NULL
           ORDER BY created_at ${direction}, id ${direction}`,
        )
        .all() as unknown as ReadonlyArray<AssignmentRow>
    ).map(decodeAssignment);
  }

  const service: StateStoreService = {
    getReceipt: (commandId) =>
      Effect.try({
        try: () => getReceiptSync(commandId),
        catch: storageError,
      }),
    admit: (input) =>
      Effect.try({ try: () => admitSync(input), catch: storageError }),
    appendEvent: (assignmentId, event, patch) =>
      Effect.try({
        try: () => appendEventSync(assignmentId, event, patch),
        catch: storageError,
      }),
    getAssignment: (assignmentId) =>
      Effect.try({
        try: () => {
          const row = assignmentQuery.get({ id: assignmentId }) as
            | AssignmentRow
            | undefined;
          return row ? decodeAssignment(row) : null;
        },
        catch: storageError,
      }),
    beginLifecycleCommand: (input) =>
      Effect.try({
        try: () => beginLifecycleCommandSync(input),
        catch: storageError,
      }),
    markLifecycleCommandExecuting: (commandId, effect, timestamp) =>
      Effect.try({
        try: () =>
          markLifecycleCommandExecutingSync(commandId, effect, timestamp),
        catch: storageError,
      }),
    finishLifecycleCommand: (commandId, consequence, timestamp, patch) =>
      Effect.try({
        try: () =>
          finishLifecycleCommandSync(commandId, consequence, timestamp, patch),
        catch: storageError,
      }),
    unfinishedLifecycleCommands: () =>
      Effect.try({
        try: () =>
          (
            database
              .prepare(
                "SELECT * FROM lifecycle_commands WHERE phase != $phase ORDER BY created_at, command_id",
              )
              .all({
                phase: "final",
              }) as unknown as ReadonlyArray<LifecycleCommandRow>
          ).map(decodeLifecycleCommand),
        catch: storageError,
      }),
    reconcileAttemptProcess: (attemptId) =>
      Effect.try({
        try: () => reconcileAttemptProcessSync(attemptId),
        catch: storageError,
      }),
    getSnapshot: () =>
      Effect.try({
        try: () => {
          const receiptRow = database
            .prepare(
              "SELECT command_id, result_json, created_at FROM command_receipts ORDER BY rowid DESC LIMIT 1",
            )
            .get() as ReceiptRow | undefined;
          const assignmentRow = database
            .prepare(
              "SELECT * FROM assignments WHERE archived_at IS NULL ORDER BY rowid DESC LIMIT 1",
            )
            .get() as AssignmentRow | undefined;
          const assignments = (
            database
              .prepare(
                `SELECT * FROM assignments
                 WHERE state IN (${sqlStateList(ACTIVE_ASSIGNMENT_STATES)})
                 ORDER BY rowid LIMIT 32`,
              )
              .all() as unknown as ReadonlyArray<AssignmentRow>
          ).map(decodeAssignment);
          const current = assignmentRow
            ? decodeAssignment(assignmentRow)
            : null;
          const events = current
            ? (
                database
                  .prepare(
                    "SELECT sequence, assignment_id, type, timestamp, detail_json FROM assignment_events WHERE assignment_id = $assignmentId ORDER BY sequence",
                  )
                  .all({
                    assignmentId: current.id,
                  }) as unknown as ReadonlyArray<EventRow>
              ).map(decodeEvent)
            : [];
          return {
            receipt: receiptRow ? decodeReceipt(receiptRow) : null,
            assignment: current,
            assignments,
            events,
            dispatch: dispatchStateSync(),
            queue: listQueueSync({ limit: 32 }),
          };
        },
        catch: storageError,
      }),
    reset: () =>
      Effect.try({
        try: () => {
          immediateTransaction(database, () => {
            database.exec("DELETE FROM issue_eligibility_observations");
            database.exec("DELETE FROM read_snapshots");
            database.exec("DELETE FROM lifecycle_commands");
            database.exec("DELETE FROM attempt_usage");
            database.exec("DELETE FROM retained_provider_events");
            database.exec("DELETE FROM attempt_transcript");
            database.exec("DELETE FROM assignment_events");
            database.exec("DELETE FROM assignments");
            database.exec("DELETE FROM issues");
            database.exec("DELETE FROM command_receipts");
            database.exec("DELETE FROM queue_tenure_versions");
            database.exec("DELETE FROM queue_tenures");
            database.exec("DELETE FROM issue_queue_status");
            database.exec(
              `UPDATE dispatch_state
               SET paused = 0, codex_enabled = 1,
                   updated_at = '1970-01-01T00:00:00.000Z'
               WHERE singleton = 1`,
            );
            database.exec(
              "DELETE FROM sqlite_sequence WHERE name IN ('assignment_events', 'attempt_transcript', 'retained_provider_events')",
            );
            database.exec(
              "DELETE FROM sqlite_sequence WHERE name = 'queue_tenure_versions'",
            );
          });
        },
        catch: storageError,
      }),
    interruptUnfinished: (timestamp, reconcileProcess) =>
      Effect.try({
        try: () => interruptUnfinishedSync(timestamp, reconcileProcess),
        catch: storageError,
      }),
    seedAssignment: (assignment, events) =>
      Effect.try({
        try: () => {
          immediateTransaction(database, () => {
            insertAssignment({ ...assignment, lastEventSequence: 0 });
            let lastSequence = 0;
            for (const event of events) {
              lastSequence = insertEvent(
                event.assignmentId,
                event.type,
                event.timestamp,
                event.detail,
              );
            }
            setLastEventSequence(assignment.id, lastSequence);
          });
        },
        catch: storageError,
      }),
    reconcileQueue: (input) =>
      Effect.try({ try: () => reconcileQueueSync(input), catch: storageError }),
    endQueueTenuresOutsideRepositories: (repositories, timestamp) =>
      Effect.try({
        try: () => {
          immediateTransaction(database, () => {
            const configured = new Set(
              repositories.map((value) => value.toLowerCase()),
            );
            const rows = database
              .prepare(
                "SELECT id, issue_repository FROM queue_tenures WHERE ended_at IS NULL",
              )
              .all() as unknown as ReadonlyArray<{
              readonly id: string;
              readonly issue_repository: string;
            }>;
            for (const row of rows) {
              if (!configured.has(row.issue_repository)) {
                endTenure(
                  row.id,
                  timestamp,
                  "repository_removed",
                  "This repository is no longer configured",
                );
              }
            }
            const statuses = database
              .prepare(
                "SELECT issue_node_id, issue_repository FROM issue_queue_status WHERE eligible = 1",
              )
              .all() as unknown as ReadonlyArray<{
              readonly issue_node_id: string;
              readonly issue_repository: string;
            }>;
            for (const status of statuses) {
              if (!configured.has(status.issue_repository)) {
                setIssueQueueStatus(
                  status.issue_node_id,
                  status.issue_repository,
                  false,
                  timestamp,
                );
                recordActiveEligibilityLosses(
                  status.issue_node_id,
                  timestamp,
                  "repository_removed",
                  "This repository is no longer configured",
                );
              }
            }
          });
        },
        catch: storageError,
      }),
    getDispatchableQueue: (limit) =>
      Effect.try({
        try: () => {
          const rows = database
            .prepare(
              `SELECT * FROM queue_tenures
               WHERE ended_at IS NULL
               ORDER BY eligible_since, issue_repository, issue_number,
                        issue_node_id, id
               LIMIT $limit`,
            )
            .all({ limit }) as unknown as ReadonlyArray<QueueTenureRow>;
          return rows.map((row) => ({
            tenureId: row.id,
            eligibleSince: row.eligible_since,
            issue: decodeQueueEntry(row).issue,
            workflow: {
              startingCommit: row.starting_commit,
              blobId: row.workflow_blob_id,
              digest: row.workflow_digest,
              body: row.workflow_body,
            },
          }));
        },
        catch: storageError,
      }),
    getActiveQueueTenureId: (issueNodeId) =>
      Effect.try({
        try: () => {
          const row = database
            .prepare(
              `SELECT id FROM queue_tenures
               WHERE issue_node_id = $issueNodeId AND ended_at IS NULL`,
            )
            .get({ issueNodeId }) as { readonly id: string } | undefined;
          return row?.id ?? null;
        },
        catch: storageError,
      }),
    markQueueTenureIneligible: (tenureId, timestamp, reason) =>
      Effect.try({
        try: () => {
          immediateTransaction(database, () => {
            const row = database
              .prepare(
                `SELECT issue_node_id, issue_repository FROM queue_tenures
                 WHERE id = $id AND ended_at IS NULL`,
              )
              .get({ id: tenureId }) as
              | {
                  readonly issue_node_id: string;
                  readonly issue_repository: string;
                }
              | undefined;
            if (!row) return;
            const prior = database
              .prepare(
                "SELECT eligible FROM issue_queue_status WHERE issue_node_id = $issueNodeId",
              )
              .get({
                issueNodeId: row.issue_node_id,
              }) as { readonly eligible: number } | undefined;
            if (!endTenure(tenureId, timestamp, reason.code, reason.message)) {
              return;
            }
            if (prior?.eligible === 1) {
              setIssueQueueStatus(
                row.issue_node_id,
                row.issue_repository,
                false,
                timestamp,
              );
              recordActiveEligibilityLosses(
                row.issue_node_id,
                timestamp,
                reason.code,
                reason.message,
              );
            }
          });
        },
        catch: storageError,
      }),
    endQueueTenure: (tenureId, timestamp, reason) =>
      Effect.try({
        try: () => {
          immediateTransaction(database, () => {
            endTenure(tenureId, timestamp, reason.code, reason.message);
          });
        },
        catch: storageError,
      }),
    listQueue: (input) =>
      Effect.try({ try: () => listQueueSync(input), catch: storageError }),
    getDispatchState: () =>
      Effect.try({ try: dispatchStateSync, catch: storageError }),
    setDispatchPaused: (paused, timestamp) =>
      Effect.try({
        try: () => {
          database
            .prepare(
              `UPDATE dispatch_state
               SET paused = $paused, updated_at = $updatedAt
               WHERE singleton = 1`,
            )
            .run({ paused: paused ? 1 : 0, updatedAt: timestamp });
          return dispatchStateSync();
        },
        catch: storageError,
      }),
    setCodexEnabled: (enabled, timestamp) =>
      Effect.try({
        try: () => {
          database
            .prepare(
              `UPDATE dispatch_state
               SET codex_enabled = $enabled, updated_at = $updatedAt
               WHERE singleton = 1`,
            )
            .run({ enabled: enabled ? 1 : 0, updatedAt: timestamp });
          return dispatchStateSync();
        },
        catch: storageError,
      }),
    getLatestEligibilityObservation: (assignmentId) =>
      Effect.try({
        try: () => {
          const row = database
            .prepare(
              `SELECT sequence, assignment_id, issue_node_id, observed_at,
                      eligible, reason_code, reason_message
               FROM issue_eligibility_observations
               WHERE assignment_id = $assignmentId
               ORDER BY sequence DESC LIMIT 1`,
            )
            .get({ assignmentId }) as
            | {
                readonly sequence: number;
                readonly assignment_id: string;
                readonly issue_node_id: string;
                readonly observed_at: string;
                readonly eligible: number;
                readonly reason_code: string | null;
                readonly reason_message: string | null;
              }
            | undefined;
          if (!row) return null;
          if (
            row.eligible !== 0 ||
            row.reason_code === null ||
            row.reason_message === null
          ) {
            throw new FactoryError({
              code: "state_store_failed",
              message: `Eligibility observation ${row.sequence} is invalid`,
            });
          }
          return {
            sequence: row.sequence,
            assignmentId: row.assignment_id,
            issueNodeId: row.issue_node_id,
            observedAt: row.observed_at,
            eligible: false as const,
            reason: {
              code: row.reason_code,
              message: row.reason_message,
            },
          };
        },
        catch: storageError,
      }),
    appendProviderRecords: (attemptId, records) =>
      Effect.try({
        try: () => appendProviderRecordsSync(attemptId, records),
        catch: storageError,
      }),
    readIssues: (request) =>
      Effect.try({
        try: () => pageRequest("issues", "", request, IssueRef, issueRows),
        catch: storageError,
      }),
    readAttempts: (request) =>
      Effect.try({
        try: () =>
          pageRequest("attempts", "", request, Assignment, () =>
            assignmentRows("history"),
          ),
        catch: storageError,
      }),
    readTranscript: (attemptId, request) =>
      Effect.try({
        try: () =>
          pageRequest("transcript", attemptId, request, TranscriptEntry, () =>
            (
              database
                .prepare(
                  "SELECT sequence, attempt_id, timestamp, role, text, truncated FROM attempt_transcript WHERE attempt_id = $attemptId ORDER BY sequence",
                )
                .all({ attemptId }) as unknown as ReadonlyArray<TranscriptRow>
            ).map(decodeTranscript),
          ),
        catch: storageError,
      }),
    readEvents: (attemptId, request) =>
      Effect.try({
        try: (): EventPage =>
          pageRequest(
            "events",
            attemptId,
            request,
            Schema.Union(AssignmentEvent, RetainedProviderEvent),
            () => {
              const lifecycle = (
                database
                  .prepare(
                    "SELECT sequence, assignment_id, type, timestamp, detail_json FROM assignment_events WHERE assignment_id = $attemptId ORDER BY sequence",
                  )
                  .all({ attemptId }) as unknown as ReadonlyArray<EventRow>
              ).map(decodeEvent);
              const provider = (
                database
                  .prepare(
                    "SELECT sequence, attempt_id, timestamp, type, detail_json FROM retained_provider_events WHERE attempt_id = $attemptId ORDER BY sequence",
                  )
                  .all({
                    attemptId,
                  }) as unknown as ReadonlyArray<ProviderEventRow>
              ).map(decodeProviderEvent);
              return [...lifecycle, ...provider].sort((left, right) =>
                left.timestamp.localeCompare(right.timestamp),
              );
            },
          ),
        catch: storageError,
      }),
    readUsage: (request) =>
      Effect.try({
        try: () =>
          pageRequest("usage", "", request, AttemptUsage, () =>
            (
              database
                .prepare(
                  "SELECT attempt_id, timestamp, total_json, last_json, model_context_window FROM attempt_usage ORDER BY timestamp, attempt_id",
                )
                .all() as unknown as ReadonlyArray<UsageRow>
            ).map(decodeUsage),
          ),
        catch: storageError,
      }),
    readTimeline: (request) =>
      Effect.try({
        try: () =>
          pageRequest("timeline", "", request, Assignment, () =>
            assignmentRows("timeline"),
          ),
        catch: storageError,
      }),
    readLifecycleCommands: (request) =>
      Effect.try({
        try: () =>
          pageRequest("lifecycle_commands", "", request, LifecycleCommand, () =>
            (
              database
                .prepare(
                  "SELECT * FROM lifecycle_commands ORDER BY created_at DESC, command_id DESC",
                )
                .all() as unknown as ReadonlyArray<LifecycleCommandRow>
            ).map(decodeLifecycleCommand),
          ),
        catch: storageError,
      }),
    pullRequestRecoveryCandidates: () =>
      Effect.try({
        try: () =>
          (
            database
              .prepare(
                `SELECT * FROM assignments
         WHERE state = $state
           AND workspace_json IS NOT NULL
           AND pull_request_json IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM assignment_events
             WHERE assignment_id = assignments.id
               AND type IN ($startedEventType, $reconciledEventType)
           )
         ORDER BY created_at`,
              )
              .all({
                state: "interrupted",
                startedEventType: ASSIGNMENT_EVENTS.pullRequestLookupStarted,
                reconciledEventType: ASSIGNMENT_EVENTS.pullRequestReconciled,
              }) as unknown as ReadonlyArray<AssignmentRow>
          ).map(decodeAssignment),
        catch: storageError,
      }),
    unfinishedPullRequestLookups: () =>
      Effect.try({
        try: () =>
          (
            database
              .prepare(
                `SELECT * FROM assignments
                 WHERE state = $state
                   AND EXISTS (
                     SELECT 1 FROM assignment_events
                     WHERE assignment_id = assignments.id AND type = $startedEventType
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM assignment_events
                     WHERE assignment_id = assignments.id AND type = $reconciledEventType
                   )
                 ORDER BY created_at`,
              )
              .all({
                state: "interrupted",
                startedEventType: ASSIGNMENT_EVENTS.pullRequestLookupStarted,
                reconciledEventType: ASSIGNMENT_EVENTS.pullRequestReconciled,
              }) as unknown as ReadonlyArray<AssignmentRow>
          ).map(decodeAssignment),
        catch: storageError,
      }),
  };

  try {
    if (options.recover) {
      interruptUnfinishedSync(new Date().toISOString(), reconcileStoredProcess);
    }
  } catch (error) {
    database.close();
    lease.release();
    throw error;
  }

  return {
    database,
    service,
    close: () => {
      database.close();
      lease.release();
    },
  };
}

function immediateTransaction<A>(
  database: DatabaseSync,
  operation: () => A,
): A {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export const layerStateStore = (
  path: string,
  options: StateStoreOptions = { recover: true },
) =>
  Layer.scoped(
    StateStore,
    Effect.acquireRelease(
      Effect.sync(() => openStateStore(path, options)),
      ({ close }) => Effect.sync(close),
    ).pipe(Effect.map(({ service }) => service)),
  );
