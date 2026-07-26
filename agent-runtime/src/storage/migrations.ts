/**
 * Schema migrations for the sidecar's SQLite database.
 *
 * This module only ever *describes* schema changes -- it never opens a
 * database itself (see ./db-worker.ts, the only file allowed to construct a
 * `better-sqlite3` `Database`). Applying migrations is a plain synchronous
 * operation over a handle the caller already owns, so this module needs no
 * async surface of its own.
 *
 * Versioning uses SQLite's built-in `user_version` pragma (an integer baked
 * into the database file header) rather than a bookkeeping table: it is
 * atomic with the rest of a migration's transaction, requires no schema of
 * its own, and is exactly what it was designed for.
 */

import type Database from "better-sqlite3";

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: Database.Database) => void;
}

/**
 * Ordered, monotonically-versioned schema changes. Table set per the sidecar
 * plan: `events`, `tasks`, `task_dependencies`, `roles`, `role_fitness`,
 * `budgets`, `pheromones`, `memories`. `runtime_metrics` is an additional,
 * purely-internal table (see ../telemetry/runtime-metrics.ts) used to
 * persist periodic telemetry snapshots through the DB Worker instead of
 * ever writing them synchronously from the main thread.
 *
 * Column names stay snake_case to match the `events` table's mirroring of
 * the wire-level RealtimeEvent envelope (see ../protocol/events.ts).
 *
 * `tasks.role_id` is a plain TEXT column, not a foreign key into `roles`:
 * task assignment references a role manifest id from the in-memory
 * RoleSessionManager (see ../roles/session-manager.ts), a lightweight,
 * constantly-changing link. `roles` itself is the heavier Gene Bank
 * persistence layer (birth reason, lifecycle, fitness -- populated by later
 * incubation/promotion work), a different lifecycle the design deliberately
 * keeps decoupled from task assignment. Enforcing that FK here would make
 * every task assignment depend on Gene Bank rows that may not exist yet.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "create core event/task/role/economy tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL,
          interaction_id TEXT,
          task_id TEXT,
          source TEXT NOT NULL,
          type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          payload TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_sequence ON events (sequence);
        CREATE INDEX IF NOT EXISTS idx_events_task_id ON events (task_id);
        CREATE INDEX IF NOT EXISTS idx_events_interaction_id ON events (interaction_id);

        CREATE TABLE IF NOT EXISTS roles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          definition TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          interaction_id TEXT NOT NULL,
          status TEXT NOT NULL,
          role_id TEXT,
          parent_task_id TEXT REFERENCES tasks (id) ON DELETE SET NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_interaction_id ON tasks (interaction_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
        CREATE INDEX IF NOT EXISTS idx_tasks_role_id ON tasks (role_id);

        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
          depends_on_task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, depends_on_task_id)
        );

        CREATE TABLE IF NOT EXISTS role_fitness (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_role_fitness_role_id ON role_fitness (role_id);

        CREATE TABLE IF NOT EXISTS budgets (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          limit_amount REAL NOT NULL,
          consumed_amount REAL NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pheromones (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          signal TEXT NOT NULL,
          strength REAL NOT NULL,
          task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          decays_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pheromones_signal ON pheromones (signal);

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          role_id TEXT REFERENCES roles (id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_role_id ON memories (role_id);
      `);
    },
  },
  {
    version: 2,
    description: "create runtime_metrics table for telemetry persistence",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recorded_at TEXT NOT NULL,
          event_loop_p50_ms REAL NOT NULL,
          event_loop_p95_ms REAL NOT NULL,
          event_loop_p99_ms REAL NOT NULL,
          rss_bytes INTEGER NOT NULL,
          queue_depth TEXT NOT NULL,
          db_latency_p50_ms REAL,
          db_latency_p95_ms REAL,
          db_latency_samples INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_metrics_recorded_at ON runtime_metrics (recorded_at);
      `);
    },
  },
];

/** Reads the schema version currently applied to `db` (0 for a brand-new database). */
export function schemaVersion(db: Database.Database): number {
  return Number(db.pragma("user_version", { simple: true }));
}

/**
 * Applies every migration newer than `db`'s current `user_version`, each in
 * its own transaction (schema change + version bump commit or roll back
 * together). Safe to call on every worker startup: already-applied
 * migrations are simply skipped. Returns the resulting schema version.
 */
export function runMigrations(db: Database.Database): number {
  const current = schemaVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      // PRAGMA statements can't be bound parameters; `migration.version` is
      // our own integer literal from the array above, never user input.
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }

  return schemaVersion(db);
}
