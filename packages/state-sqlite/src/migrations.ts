import type { DatabaseSync } from "node:sqlite";
import { FactoryError } from "@irudd-factory/application";
import {
  ASSIGNMENT_STATES,
  ACTIVE_ASSIGNMENT_STATES,
} from "@irudd-factory/contracts";
import { sqlStateList } from "./sql.ts";

export const DATABASE_SCHEMA_VERSION = 3;

const statements = [
  `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE command_receipts (
    command_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    issue_node_id TEXT NOT NULL,
    issue_repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_url TEXT NOT NULL,
    issue_title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (${sqlStateList(ASSIGNMENT_STATES)})),
    starting_commit TEXT NOT NULL,
    workflow_blob_id TEXT NOT NULL,
    workflow_digest TEXT NOT NULL,
    workflow_body TEXT NOT NULL,
    workspace_json TEXT,
    requested_model TEXT NOT NULL,
    requested_effort TEXT NOT NULL,
    observed_model TEXT,
    observed_effort TEXT,
    codex_version TEXT,
    thread_id TEXT,
    turn_id TEXT,
    process_group_id INTEGER,
    process_start_identity TEXT,
    process_start_pending INTEGER NOT NULL CHECK (process_start_pending IN (0, 1)),
    pull_request_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  `CREATE UNIQUE INDEX assignments_one_active_issue
   ON assignments(issue_node_id)
   WHERE state IN (${sqlStateList(ACTIVE_ASSIGNMENT_STATES)})`,
  `CREATE INDEX assignments_active_provider
   ON assignments(provider, state)`,
  `CREATE TABLE assignment_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    detail_json TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX assignment_events_assignment_sequence
   ON assignment_events(assignment_id, sequence)`,
  `CREATE TABLE dispatch_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    codex_enabled INTEGER NOT NULL CHECK (codex_enabled IN (0, 1)),
    updated_at TEXT NOT NULL
  ) STRICT`,
  `INSERT INTO dispatch_state(singleton, paused, codex_enabled, updated_at)
   VALUES (1, 0, 1, '1970-01-01T00:00:00.000Z')`,
  `CREATE TABLE queue_tenures (
    id TEXT PRIMARY KEY,
    issue_node_id TEXT NOT NULL,
    issue_repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_url TEXT NOT NULL,
    issue_title TEXT NOT NULL,
    starting_commit TEXT NOT NULL,
    workflow_blob_id TEXT NOT NULL,
    workflow_digest TEXT NOT NULL,
    workflow_body TEXT NOT NULL,
    eligible_since TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    ended_at TEXT,
    reason_code TEXT,
    reason_message TEXT,
    CHECK ((ended_at IS NULL AND reason_code IS NULL AND reason_message IS NULL)
      OR (ended_at IS NOT NULL AND reason_code IS NOT NULL AND reason_message IS NOT NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX queue_one_active_tenure
   ON queue_tenures(issue_node_id) WHERE ended_at IS NULL`,
  `CREATE INDEX queue_active_order
   ON queue_tenures(eligible_since, issue_repository, issue_number, issue_node_id, id)
   WHERE ended_at IS NULL`,
  `CREATE INDEX queue_repository_active
   ON queue_tenures(issue_repository) WHERE ended_at IS NULL`,
  `CREATE TABLE issue_queue_status (
    issue_node_id TEXT PRIMARY KEY,
    issue_repository TEXT NOT NULL,
    eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
    observed_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX issue_queue_status_repository
   ON issue_queue_status(issue_repository, eligible)`,
  `CREATE TABLE queue_tenure_versions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    tenure_id TEXT NOT NULL REFERENCES queue_tenures(id) ON DELETE CASCADE,
    issue_node_id TEXT NOT NULL,
    issue_repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_url TEXT NOT NULL,
    issue_title TEXT NOT NULL,
    starting_commit TEXT NOT NULL,
    workflow_blob_id TEXT NOT NULL,
    workflow_digest TEXT NOT NULL,
    workflow_body TEXT NOT NULL,
    eligible_since TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    ended_at TEXT,
    reason_code TEXT,
    reason_message TEXT
  ) STRICT`,
  `CREATE INDEX queue_tenure_versions_tenure_revision
   ON queue_tenure_versions(tenure_id, revision)`,
  `CREATE TABLE issue_eligibility_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    issue_node_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
    reason_code TEXT,
    reason_message TEXT
  ) STRICT`,
  `CREATE INDEX issue_eligibility_assignment_sequence
   ON issue_eligibility_observations(assignment_id, sequence)`,
] as const;

function resetRequired(detail: string): never {
  throw new FactoryError({
    code: "database_reset_required",
    message: "Factory database is incompatible and must be reset",
    detail,
  });
}

export function migrate(database: DatabaseSync): void {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as unknown as ReadonlyArray<{ readonly name: string }>;
  if (tables.length > 0) {
    if (!tables.some(({ name }) => name === "schema_migrations")) {
      resetRequired("schema_migrations is missing");
    }
    let versions: ReadonlyArray<{ readonly version: number }>;
    try {
      versions = database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as unknown as ReadonlyArray<{ readonly version: number }>;
    } catch (error) {
      resetRequired(String(error));
    }
    if (
      versions.length !== 1 ||
      versions[0]?.version !== DATABASE_SCHEMA_VERSION
    ) {
      resetRequired(
        `expected schema ${DATABASE_SCHEMA_VERSION}, found ${versions.map(({ version }) => version).join(", ") || "none"}`,
      );
    }
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) database.exec(statement);
    database
      .prepare(
        `INSERT INTO schema_migrations(version, applied_at)
         VALUES ($version, $appliedAt)`,
      )
      .run({
        version: DATABASE_SCHEMA_VERSION,
        appliedAt: new Date().toISOString(),
      });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
