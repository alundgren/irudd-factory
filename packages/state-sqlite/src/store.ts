import { Database } from "bun:sqlite";
import type {
  AdmissionInput,
  AssignmentPatch,
  AdmissionResult,
  StateStoreService,
} from "@irudd-factory/application";
import { FactoryError, StateStore } from "@irudd-factory/application";
import {
  Assignment,
  AssignmentEvent,
  CommandReceipt,
  type CommandResult,
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

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function decodeAssignment(row: AssignmentRow): Assignment {
  return Schema.decodeUnknownSync(Assignment)({
    id: row.id,
    provider: row.provider,
    issue: {
      nodeId: row.issue_node_id,
      repository: row.issue_repository,
      number: row.issue_number,
      url: row.issue_url,
      title: row.issue_title,
    },
    state: row.state,
    workflow: {
      startingCommit: row.starting_commit,
      blobId: row.workflow_blob_id,
      digest: row.workflow_digest,
      body: row.workflow_body,
    },
    workspace: row.workspace_json ? parseJson(row.workspace_json) : null,
    requestedModel: row.requested_model,
    requestedEffort: row.requested_effort,
    observedModel: row.observed_model,
    observedEffort: row.observed_effort,
    codexVersion: row.codex_version,
    threadId: row.thread_id,
    turnId: row.turn_id,
    pullRequest: row.pull_request_json
      ? parseJson(row.pull_request_json)
      : null,
    error: row.error_json ? parseJson(row.error_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventSequence: row.last_event_sequence,
  });
}

function decodeEvent(row: EventRow): AssignmentEvent {
  return Schema.decodeUnknownSync(AssignmentEvent)({
    sequence: row.sequence,
    assignmentId: row.assignment_id,
    type: row.type,
    timestamp: row.timestamp,
    detail: parseJson(row.detail_json),
  });
}

function decodeReceipt(row: ReceiptRow): CommandReceipt {
  return Schema.decodeUnknownSync(CommandReceipt)({
    commandId: row.command_id,
    result: parseJson(row.result_json),
    createdAt: row.created_at,
  });
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

  const receiptQuery = database.query<ReceiptRow, [string]>(
    "SELECT command_id, result_json, created_at FROM command_receipts WHERE command_id = ?",
  );
  const assignmentQuery = database.query<AssignmentRow, [string]>(
    "SELECT * FROM assignments WHERE id = ?",
  );

  function getReceiptSync(commandId: string) {
    const row = receiptQuery.get(commandId);
    return row ? decodeReceipt(row) : null;
  }

  function insertReceipt(
    commandId: string,
    result: CommandResult,
    timestamp: string,
  ): CommandReceipt {
    database
      .query(
        "INSERT INTO command_receipts(command_id, result_json, created_at) VALUES (?, ?, ?)",
      )
      .run(commandId, JSON.stringify(result), timestamp);
    return Schema.decodeUnknownSync(CommandReceipt)({
      commandId,
      result,
      createdAt: timestamp,
    });
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
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      )
      .run(
        value.id,
        value.provider,
        value.issue.nodeId,
        value.issue.repository,
        value.issue.number,
        value.issue.url,
        value.issue.title,
        value.state,
        value.workflow.startingCommit,
        value.workflow.blobId,
        value.workflow.digest,
        value.workflow.body,
        value.workspace ? JSON.stringify(value.workspace) : null,
        value.requestedModel,
        value.requestedEffort,
        value.observedModel,
        value.observedEffort,
        value.codexVersion,
        value.threadId,
        value.turnId,
        value.pullRequest ? JSON.stringify(value.pullRequest) : null,
        value.error ? JSON.stringify(value.error) : null,
        value.createdAt,
        value.updatedAt,
        value.lastEventSequence,
      );
  }

  function admitSync(input: AdmissionInput): AdmissionResult {
    return database
      .transaction(() => {
        const existing = getReceiptSync(input.commandId);
        if (existing) return { receipt: existing, created: false };

        const activeRow = database
          .query<AssignmentRow, [string]>(
            `SELECT * FROM assignments
           WHERE provider = ? AND state IN ('reserved', 'starting', 'running')
           LIMIT 1`,
          )
          .get(input.provider);
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

        const unseen = input.candidates.filter((candidate) => {
          const found = database
            .query<
              { present: number },
              [string]
            >("SELECT 1 AS present FROM assignments WHERE issue_node_id = ? LIMIT 1")
            .get(candidate.issue.nodeId);
          return !found;
        });
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
        const value = Schema.decodeUnknownSync(Assignment)({
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
        });
        insertAssignment(value);
        const eventResult = database
          .query(
            "INSERT INTO assignment_events(assignment_id, type, timestamp, detail_json) VALUES (?, ?, ?, ?)",
          )
          .run(value.id, "assignment.reserved", input.timestamp, "{}");
        const sequence = Number(eventResult.lastInsertRowid);
        database
          .query("UPDATE assignments SET last_event_sequence = ? WHERE id = ?")
          .run(sequence, value.id);
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
        const currentRow = assignmentQuery.get(assignmentId);
        if (!currentRow) {
          throw new FactoryError({
            code: "assignment_not_found",
            message: `Assignment ${assignmentId} was not found`,
          });
        }
        const current = decodeAssignment(currentRow);
        const next = Schema.decodeUnknownSync(Assignment)({
          ...current,
          ...patch,
          updatedAt: event.timestamp,
        });
        const eventResult = database
          .query(
            "INSERT INTO assignment_events(assignment_id, type, timestamp, detail_json) VALUES (?, ?, ?, ?)",
          )
          .run(
            assignmentId,
            event.type,
            event.timestamp,
            JSON.stringify(event.detail),
          );
        const sequence = Number(eventResult.lastInsertRowid);
        database
          .query(
            `UPDATE assignments SET
            state = ?, workspace_json = ?, observed_model = ?, observed_effort = ?,
            codex_version = ?, thread_id = ?, turn_id = ?, pull_request_json = ?,
            error_json = ?, updated_at = ?, last_event_sequence = ?
           WHERE id = ?`,
          )
          .run(
            next.state,
            next.workspace ? JSON.stringify(next.workspace) : null,
            next.observedModel,
            next.observedEffort,
            next.codexVersion,
            next.threadId,
            next.turnId,
            next.pullRequest ? JSON.stringify(next.pullRequest) : null,
            next.error ? JSON.stringify(next.error) : null,
            next.updatedAt,
            sequence,
            assignmentId,
          );
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
          const row = assignmentQuery.get(assignmentId);
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
                  [string]
                >("SELECT sequence, assignment_id, type, timestamp, detail_json FROM assignment_events WHERE assignment_id = ? ORDER BY sequence")
                .all(current.id)
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
                const result = database
                  .query(
                    "INSERT INTO assignment_events(assignment_id, type, timestamp, detail_json) VALUES (?, ?, ?, ?)",
                  )
                  .run(
                    event.assignmentId,
                    event.type,
                    event.timestamp,
                    JSON.stringify(event.detail),
                  );
                lastSequence = Number(result.lastInsertRowid);
              }
              database
                .query(
                  "UPDATE assignments SET last_event_sequence = ? WHERE id = ?",
                )
                .run(lastSequence, assignment.id);
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
