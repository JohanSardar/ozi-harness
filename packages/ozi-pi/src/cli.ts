#!/usr/bin/env node
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { type Fix, type Mistake, type Replay } from "./RepairModel.ts";
import { openStore } from "./store.ts";
import { list, logMistake, locked, statePath, withEngine, work } from "./repair.ts";
import * as Schema from "effect/Schema";
import { LogMistake } from "./RepairModel.ts";

try {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      "data-root": { type: "string" },
      json: { type: "boolean" },
      session: { type: "string" },
      input: { type: "string" },
      timeout: { type: "string" },
    },
  });
  const root = NodePath.resolve(
    values["data-root"] ?? process.env.OZI_DATA_ROOT ?? NodePath.join(NodeOS.homedir(), "ozi"),
  );
  const state = statePath(root);
  const [command, id, target, wanted] = positionals;
  let result: unknown;
  if (command === "worker") {
    await work(root, state);
    result = { finished: true };
  } else if (command === "undo") {
    if (!id) throw new Error("undo requires a fix ID");
    result = await locked(NodePath.join(state, "worker"), () =>
      withEngine(root, state, (engine) => engine.undo(id)),
    );
  } else {
    const db = openStore(state);
    try {
      if (command === "mistakes" && id === "log") {
        if (!values.session || !values.input)
          throw new Error("mistakes log requires --session and --input JSON");
        const input = Schema.decodeUnknownSync(LogMistake)(JSON.parse(values.input));
        result = logMistake(db, values.session, input);
      } else if (command === "mistakes" || command === "replays" || command === "fixes") {
        result = list(db, command);
      } else if (command === "sessions") {
        result = db.prepare("SELECT id,file,active FROM ozi_sessions").all();
      } else if (command === "events") {
        const row = db.prepare("SELECT snapshot FROM ozi_sessions WHERE id=?").get(id ?? "");
        if (!row) throw new Error("unknown-session");
        result = JSON.parse(String(row.snapshot));
      } else if (command === "blockers") {
        result = db.prepare("SELECT * FROM ozi_blockers").all();
      } else if (command === "wait") {
        if (!["mistake", "replay", "fix"].includes(id ?? "") || !target || !wanted)
          throw new Error("wait requires mistake|replay|fix ID STATE");
        const table = id === "mistake" ? "mistakes" : id === "replay" ? "replays" : "fixes";
        const seconds = Number(values.timeout ?? "120");
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("invalid-timeout");
        result = await Effect.runPromise(
          Effect.callback<Mistake | Replay | Fix>((resume) => {
            let finished = false;
            const check = () => {
              if (finished) return;
              const row = list<Mistake | Replay | Fix>(db, table).find((row) => row.id === target);
              const status = row && ("status" in row ? row.status : row.state);
              if (
                row &&
                (status === wanted ||
                  ("checkpoint" in row && wanted === `at:${row.checkpoint}`) ||
                  (wanted === "finished" && ["passed", "failed"].includes(status!)))
              ) {
                finished = true;
                watcher.close();
                resume(Effect.succeed(row));
              }
            };
            const watcher = NodeFS.watch(state, check);
            check();
            return Effect.sync(() => {
              finished = true;
              watcher.close();
            });
          }).pipe(Effect.timeout(`${seconds} seconds`)),
        );
      } else
        throw new Error(
          "Usage: ozi-harness mistakes|replays|fixes|undo|wait|sessions|events|blockers --data-root PATH --json",
        );
    } finally {
      db.close();
    }
  }
  process.stdout.write(
    `${values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message.split("\n")[0] : "Repair failed"}\n`,
  );
  process.exitCode = 1;
}
