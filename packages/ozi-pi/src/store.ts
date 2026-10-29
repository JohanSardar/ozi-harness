import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

export function openStore(stateDir: string) {
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "repair.sqlite"));
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS ozi_mistakes (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, thread TEXT NOT NULL, boundary TEXT,
      fingerprint TEXT NOT NULL, what TEXT NOT NULL, why TEXT NOT NULL, harness TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('logged','testing','failed','shipped','undone')),
      source_event_id TEXT NOT NULL, trigger_event_id TEXT, UNIQUE(source_event_id,fingerprint)
    );
    CREATE TABLE IF NOT EXISTS ozi_replays (
      id TEXT PRIMARY KEY, mistake_id TEXT NOT NULL UNIQUE REFERENCES ozi_mistakes(id),
      at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','passed','failed')),
      reason TEXT, case_json TEXT, evidence_json TEXT
    );
    CREATE TABLE IF NOT EXISTS ozi_fixes (
      id TEXT PRIMARY KEY REFERENCES ozi_mistakes(id), at TEXT NOT NULL, commit_sha TEXT NOT NULL,
      predecessor TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('publishing','shipped','undoing','undone','failed')),
      before_head TEXT, target TEXT NOT NULL, snapshot TEXT NOT NULL, paths_json TEXT NOT NULL,
      conflict INTEGER NOT NULL DEFAULT 0, checkpoint TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS ozi_checks (id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ozi_sessions (id TEXT PRIMARY KEY, file TEXT, active INTEGER NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ozi_user_messages (session TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(session,id));
    CREATE TABLE IF NOT EXISTS ozi_blockers (id TEXT PRIMARY KEY, detail TEXT NOT NULL);
  `);
  return db;
}

export const sqlLayer = (db: NodeSqlite.DatabaseSync) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const run = (sql: string, params: ReadonlyArray<unknown>, arrays = false) =>
        Effect.try({
          try: () => {
            const statement = db.prepare(sql);
            statement.setReturnArrays(arrays);
            return statement.all(...(params as NodeSqlite.SQLInputValue[]));
          },
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Repair storage failed",
                operation: "execute",
              }),
            }),
        });
      const connection: Connection = {
        execute: (sql, params, transform) =>
          transform ? run(sql, params).pipe(Effect.map(transform)) : run(sql, params),
        executeRaw: (sql, params) => run(sql, params),
        executeValues: (sql, params) =>
          run(sql, params, true) as unknown as Effect.Effect<
            ReadonlyArray<ReadonlyArray<unknown>>,
            SqlError
          >,
        executeValuesUnprepared: (sql, params) =>
          run(sql, params ?? [], true) as unknown as Effect.Effect<
            ReadonlyArray<ReadonlyArray<unknown>>,
            SqlError
          >,
        executeUnprepared: (sql, params, transform) =>
          transform ? run(sql, params ?? []).pipe(Effect.map(transform)) : run(sql, params ?? []),
        executeStream: (sql, params) =>
          Stream.fromEffect(run(sql, params)).pipe(
            Stream.flatMap((rows) => Stream.fromIterable(rows)),
          ),
      };
      const permit = yield* Semaphore.make(1);
      const acquirer = Effect.acquireRelease(permit.take(1), () => permit.release(1)).pipe(
        Effect.as(connection),
      );
      return yield* SqlClient.make({
        acquirer,
        compiler: Statement.makeCompilerSqlite(),
        spanAttributes: [],
        beginTransaction: "BEGIN IMMEDIATE",
      });
    }),
  ).pipe(Layer.provide(Reactivity.layer));
