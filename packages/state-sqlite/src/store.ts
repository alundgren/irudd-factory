import { Database } from "bun:sqlite";
import type {
  AdmissionInput,
  AssignmentPatch,
  AdmissionResult,
  StateStoreService,
} from "@irudd-factory/application";
import { FactoryError, StateStore } from "@irudd-factory/application";
import {
  type Assignment,
  AssignmentState,
  type AssignmentEvent,
  AssignmentEventDetail,
  type CommandReceipt,
  CommandResult,
  NormalizedError,
  PullRequest,
  WorkspacePaths,
} from "@irudd-factory/contracts";
import { Effect, Layer, Schema } from "effect";
import { migrate } from "./migrations.ts";

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

function storageError(error: unknown): FactoryError {
  return error instanceof FactoryError
    ? error
    : new FactoryError({
        code: "state_store_failed",
        message: String(error),
      });
}

/**
 * Only the JSON columns and the `state` enum carry values SQLite cannot
 * constrain to the domain type. Everything else is already the right shape in
 * the row, so it is assigned rather than revalidated on every read.
 */
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
    detail: decodeJson(AssignmentEventDetail, row.detail_json),
  };
}

function decodeReceipt(row: ReceiptRow): CommandReceipt {
  return {
    commandId: row.command_id,
    result: decodeJson(CommandResult, row.result_json),
    createdAt: row.created_at,
  };
}

export interface OpenStateStore {
  readonly database: Database;
  readonly service: StateStoreService;
  readonly close: () => void;
}

export function openStateStore(path: string): OpenStateStore {
  const database = new Database(path, { create: true, strict: true });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  migrate(database);

  const receiptQuery = database.query<ReceiptRow, [{ commandId: string }]>(
    "SELECT command_id, result_json, created_at FROM command_receipts WHERE command_id = $commandId",
  );
  const assignmentQuery = database.query<AssignmentRow, [{ id: string }]>(
    "SELECT * FROM assignments WHERE id = $id",
  );

  function getReceiptSync(commandId: string) {
    const row = receiptQuery.get({ commandId });
    return row ? decodeReceipt(row) : null;
  }

  function insertReceipt(
    commandId: string,
    result: CommandResult,
    timestamp: string,
  ): CommandReceipt {
    database
      .query(
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
      .query(
        `INSERT INTO assignments(
          id, provider, issue_node_id, issue_repository, issue_number,
          issue_url, issue_title, state, starting_commit, workflow_blob_id,
          workflow_digest, workflow_body, workspace_json, requested_model,
          requested_effort, observed_model, observed_effort, codex_version,
          thread_id, turn_id, pull_request_json, error_json, created_at,
          updated_at, last_event_sequence
        ) VALUES (
          $id, $provider, $issueNodeId, $issueRepository, $issueNumber,
          $issueUrl, $issueTitle, $state, $startingCommit, $workflowBlobId,
          $workflowDigest, $workflowBody, $workspaceJson, $requestedModel,
          $requestedEffort, $observedModel, $observedEffort, $codexVersion,
          $threadId, $turnId, $pullRequestJson, $errorJson, $createdAt,
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
      .query(
        `INSERT INTO assignment_events(assignment_id, type, timestamp, detail_json)
         VALUES ($assignmentId, $type, $timestamp, $detailJson)`,
      )
      .run({
        assignmentId,
        type,
        timestamp,
        detailJson: JSON.stringify(detail),
      });
    return Number(result.lastInsertRowid);
  }

  function setLastEventSequence(assignmentId: string, sequence: number): void {
    database
      .query(
        "UPDATE assignments SET last_event_sequence = $sequence WHERE id = $id",
      )
      .run({ sequence, id: assignmentId });
  }

  function admitSync(input: AdmissionInput): AdmissionResult {
    return database
      .transaction(() => {
        const existing = getReceiptSync(input.commandId);
        if (existing) return { receipt: existing, created: false };

        const activeRow = database
          .query<AssignmentRow, [{ provider: string }]>(
            `SELECT * FROM assignments
             WHERE provider = $provider
               AND state IN ('reserved', 'starting', 'running')
             LIMIT 1`,
          )
          .get({ provider: input.provider });
        if (activeRow) {
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

        const seenIssueQuery = database.query<
          { present: number },
          [{ issueNodeId: string }]
        >(
          "SELECT 1 AS present FROM assignments WHERE issue_node_id = $issueNodeId LIMIT 1",
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
          requestedModel: input.requestedModel,
          requestedEffort: input.requestedEffort,
          observedModel: null,
          observedEffort: null,
          codexVersion: null,
          threadId: null,
          turnId: null,
          pullRequest: null,
          error: null,
          createdAt: input.timestamp,
          updatedAt: input.timestamp,
          lastEventSequence: 0,
        };
        insertAssignment(value);
        const sequence = insertEvent(
          value.id,
          "assignment.reserved",
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
      })
      .immediate();
  }

  function appendEventSync(
    assignmentId: string,
    event: Omit<AssignmentEvent, "sequence" | "assignmentId">,
    patch: AssignmentPatch = {},
  ): Assignment {
    return database
      .transaction(() => {
        const currentRow = assignmentQuery.get({ id: assignmentId });
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
          updatedAt: event.timestamp,
        };
        const sequence = insertEvent(
          assignmentId,
          event.type,
          event.timestamp,
          event.detail,
        );
        database
          .query(
            `UPDATE assignments SET
               state = $state,
               workspace_json = $workspaceJson,
               observed_model = $observedModel,
               observed_effort = $observedEffort,
               codex_version = $codexVersion,
               thread_id = $threadId,
               turn_id = $turnId,
               pull_request_json = $pullRequestJson,
               error_json = $errorJson,
               updated_at = $updatedAt,
               last_event_sequence = $lastEventSequence
             WHERE id = $id`,
          )
          .run({
            state: next.state,
            workspaceJson: next.workspace
              ? JSON.stringify(next.workspace)
              : null,
            observedModel: next.observedModel,
            observedEffort: next.observedEffort,
            codexVersion: next.codexVersion,
            threadId: next.threadId,
            turnId: next.turnId,
            pullRequestJson: next.pullRequest
              ? JSON.stringify(next.pullRequest)
              : null,
            errorJson: next.error ? JSON.stringify(next.error) : null,
            updatedAt: next.updatedAt,
            lastEventSequence: sequence,
            id: assignmentId,
          });
        return { ...next, lastEventSequence: sequence };
      })
      .immediate();
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
          const row = assignmentQuery.get({ id: assignmentId });
          return row ? decodeAssignment(row) : null;
        },
        catch: storageError,
      }),
    getSnapshot: () =>
      Effect.try({
        try: () => {
          const receiptRow = database
            .query<
              ReceiptRow,
              []
            >("SELECT command_id, result_json, created_at FROM command_receipts ORDER BY rowid DESC LIMIT 1")
            .get();
          const assignmentRow = database
            .query<
              AssignmentRow,
              []
            >("SELECT * FROM assignments ORDER BY rowid DESC LIMIT 1")
            .get();
          const current = assignmentRow
            ? decodeAssignment(assignmentRow)
            : null;
          const events = current
            ? database
                .query<
                  EventRow,
                  [{ assignmentId: string }]
                >("SELECT sequence, assignment_id, type, timestamp, detail_json FROM assignment_events WHERE assignment_id = $assignmentId ORDER BY sequence")
                .all({ assignmentId: current.id })
                .map(decodeEvent)
            : [];
          return {
            receipt: receiptRow ? decodeReceipt(receiptRow) : null,
            assignment: current,
            events,
          };
        },
        catch: storageError,
      }),
    reset: () =>
      Effect.try({
        try: () => {
          database
            .transaction(() => {
              database.exec("DELETE FROM assignment_events");
              database.exec("DELETE FROM assignments");
              database.exec("DELETE FROM command_receipts");
              database.exec(
                "DELETE FROM sqlite_sequence WHERE name = 'assignment_events'",
              );
            })
            .immediate();
        },
        catch: storageError,
      }),
    seedAssignment: (assignment, events) =>
      Effect.try({
        try: () => {
          database
            .transaction(() => {
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
            })
            .immediate();
        },
        catch: storageError,
      }),
  };

  return { database, service, close: () => database.close(false) };
}

export const layerStateStore = (path: string) =>
  Layer.scoped(
    StateStore,
    Effect.acquireRelease(
      Effect.sync(() => openStateStore(path)),
      ({ close }) => Effect.sync(close),
    ).pipe(Effect.map(({ service }) => service)),
  );
