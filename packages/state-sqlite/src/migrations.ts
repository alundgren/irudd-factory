import type { Database } from "bun:sqlite";
import {
  ACTIVE_ASSIGNMENT_STATES,
  ASSIGNMENT_STATES,
} from "@irudd-factory/contracts";
import { sqlStateList } from "./sql.ts";

interface Migration {
  readonly version: number;
  readonly statements: ReadonlyArray<string>;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE command_receipts (
        command_id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        issue_node_id TEXT NOT NULL UNIQUE,
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
        pull_request_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL DEFAULT 0
      ) STRICT`,
      `CREATE UNIQUE INDEX assignments_one_nonterminal_provider
       ON assignments(provider)
       WHERE state IN (${sqlStateList(ACTIVE_ASSIGNMENT_STATES)})`,
      `CREATE TABLE assignment_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        detail_json TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX assignment_events_assignment_sequence
       ON assignment_events(assignment_id, sequence)`,
    ],
  },
];

export function migrate(database: Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const applied = new Set(
    database
      .query<{ version: number }, []>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
      .all()
      .map(({ version }) => version),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database
      .transaction(() => {
        for (const statement of migration.statements) database.exec(statement);
        database
          .query(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, new Date().toISOString());
      })
      .immediate();
  }
}
