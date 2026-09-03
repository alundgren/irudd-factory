import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  mkdirSync,
  openSync,
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
  StateStoreService,
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
    const startTime = fields[19];
    return startTime ? `${pid}:${startTime}` : null;
  } catch {
    return null;
  }
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
      case ASSIGNMENT_EVENTS.interrupted:
        return shortText(detail.processReconciliation)
          ? { processReconciliation: shortText(detail.processReconciliation) }
          : {};
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
          updated_at, last_event_sequence
        ) VALUES (
          $id, $provider, $issueNodeId, $issueRepository, $issueNumber,
          $issueUrl, $issueTitle, $state, $startingCommit, $workflowBlobId,
          $workflowDigest, $workflowBody, $workspaceJson, $requestedModel,
          $requestedEffort, $observedModel, $observedEffort, $codexVersion,
          $threadId, $turnId, $processGroupId, $processStartIdentity,
          $processStartPending,
          $pullRequestJson, $errorJson, $createdAt,
          $updatedAt, $lastEventSequence
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

  function admitSync(input: AdmissionInput): AdmissionResult {
    return immediateTransaction(database, () => {
      const existing = getReceiptSync(input.commandId);
      if (existing) return { receipt: existing, created: false };

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
        return {
          receipt: insertReceipt(
            input.commandId,
            {
              _tag: "provider_busy",
              assignment: decodeAssignment(activeRow),
            },
            input.timestamp,
          ),
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
          updatedAt: next.updatedAt,
          lastEventSequence: sequence,
          id: assignmentId,
        });
      return { ...next, lastEventSequence: sequence };
    });
  }

  function reconcileStoredProcess(identity: {
    readonly processGroupId: number;
    readonly processStartIdentity: string;
  }): "exited" | "terminated" | "uncertain" {
    const current = processStartIdentity(identity.processGroupId);
    if (current === null || current !== identity.processStartIdentity) {
      return "exited";
    }
    try {
      process.kill(-identity.processGroupId, "SIGTERM");
      if (
        processStartIdentity(identity.processGroupId) ===
        identity.processStartIdentity
      ) {
        process.kill(-identity.processGroupId, "SIGKILL");
      }
      return "terminated";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? "exited"
        : "uncertain";
    }
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
      appendEventSync(
        assignment.id,
        {
          type: ASSIGNMENT_EVENTS.interrupted,
          timestamp,
          detail: { processReconciliation: outcome },
        },
        {
          state: uncertain ? "ownership_uncertain" : "interrupted",
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
          `SELECT * FROM assignments ORDER BY created_at ${direction}, id ${direction}`,
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
    getSnapshot: () =>
      Effect.try({
        try: () => {
          const receiptRow = database
            .prepare(
              "SELECT command_id, result_json, created_at FROM command_receipts ORDER BY rowid DESC LIMIT 1",
            )
            .get() as ReceiptRow | undefined;
          const assignmentRow = database
            .prepare("SELECT * FROM assignments ORDER BY rowid DESC LIMIT 1")
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
          };
        },
        catch: storageError,
      }),
    reset: () =>
      Effect.try({
        try: () => {
          immediateTransaction(database, () => {
            database.exec("DELETE FROM read_snapshots");
            database.exec("DELETE FROM attempt_usage");
            database.exec("DELETE FROM retained_provider_events");
            database.exec("DELETE FROM attempt_transcript");
            database.exec("DELETE FROM assignment_events");
            database.exec("DELETE FROM assignments");
            database.exec("DELETE FROM issues");
            database.exec("DELETE FROM command_receipts");
            database.exec(
              "DELETE FROM sqlite_sequence WHERE name IN ('assignment_events', 'attempt_transcript', 'retained_provider_events')",
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
             WHERE assignment_id = assignments.id AND type = $eventType
           )
         ORDER BY created_at`,
              )
              .all({
                state: "interrupted",
                eventType: ASSIGNMENT_EVENTS.pullRequestReconciled,
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
