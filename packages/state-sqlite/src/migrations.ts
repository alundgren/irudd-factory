import type { DatabaseSync } from "node:sqlite";
import { FactoryError } from "@irudd-factory/application";
import {
  ASSIGNMENT_STATES,
  ACTIVE_ASSIGNMENT_STATES,
} from "@irudd-factory/contracts";
import { sqlStateList } from "./sql.ts";

export const DATABASE_SCHEMA_VERSION = 2;

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
