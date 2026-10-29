import { RepairError as PublicationError } from "./RepairModel.ts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import lockfile from "proper-lockfile";
import { Publisher } from "./Publisher.ts";
import * as Publication from "./Publisher.ts";
import { RepairSandbox } from "./RepairSandbox.ts";
import * as Sandbox from "./RepairSandbox.ts";
import { RepairHost } from "./RepairHost.ts";
import { type LogMistake, type Mistake, type Fix } from "./RepairModel.ts";
import { makeHost } from "./host.ts";
import { openStore, sqlLayer } from "./store.ts";

export type SessionSnapshot = {
  header: SessionHeader;
  entries: SessionEntry[];
  tools: { name: string; description: string; inputSchema: unknown }[];
  model: string;
  thinking: string;
};
type Session = { id: string; file: string | null; active: number; snapshot: string };
const isRepairError = Schema.is(PublicationError);
const sha = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const fail = (reason: string): never => {
  throw new Error(reason);
};
export const textOf = (entry: SessionEntry) =>
  entry.type === "message" && "content" in entry.message
    ? typeof entry.message.content === "string"
      ? entry.message.content
      : entry.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
    : "";
export const statePath = (dataRoot: string) =>
  NodePath.join(NodePath.dirname(dataRoot), `.${NodePath.basename(dataRoot)}-harness`);
export const acquireRoot = (file: string) =>
  lockfile.lock(file, {
    realpath: false,
    retries: { retries: 120, minTimeout: 50, maxTimeout: 500 },
    stale: 10000,
  });
export async function locked<A>(file: string, run: () => Promise<A>) {
  const release = await acquireRoot(file);
  try {
    return await run();
  } finally {
    await release();
  }
}
export function list<A>(db: NodeSqlite.DatabaseSync, table: "mistakes" | "replays" | "fixes") {
  return db.prepare(`SELECT * FROM ozi_${table} ORDER BY at,id`).all() as A[];
}
export function syncSession(
  db: NodeSqlite.DatabaseSync,
  id: string,
  file: string | undefined,
  active: boolean,
  snapshot: SessionSnapshot,
  userId?: string,
) {
  db.prepare(
    "INSERT INTO ozi_sessions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET file=excluded.file,active=excluded.active,snapshot=excluded.snapshot",
  ).run(id, file ?? null, Number(active), JSON.stringify(snapshot));
  if (userId) db.prepare("INSERT OR IGNORE INTO ozi_user_messages VALUES (?,?)").run(id, userId);
}
export function logMistake(db: NodeSqlite.DatabaseSync, sessionId: string, input: LogMistake) {
  const session = db.prepare("SELECT * FROM ozi_sessions WHERE id=?").get(sessionId) as
    | Session
    | undefined;
  if (!session) return fail("unknown-session");
  const snapshot: SessionSnapshot = JSON.parse(session.snapshot);
  const entries = snapshot.entries;
  const index = entries.findIndex(
    (entry) =>
      entry.id === input.sourceEventId &&
      entry.type === "message" &&
      entry.message.role === "assistant",
  );
  if (index < 0) return fail("invalid-source-event");
  const trusted = (id: string) =>
    Boolean(
      db.prepare("SELECT 1 FROM ozi_user_messages WHERE session=? AND id=?").get(sessionId, id),
    );
  const boundary = input.beforeUserMessageId
    ? entries
        .slice(0, index)
        .find((entry) => entry.id === input.beforeUserMessageId && trusted(entry.id))
    : entries
        .slice(0, index)
        .findLast(
          (entry) => entry.type === "message" && entry.message.role === "user" && trusted(entry.id),
        );
  const correction = entries.find(
    (entry, position) =>
      position > index && entry.id === input.correctionMessageId && trusted(entry.id),
  );
  const repeat = list<Mistake>(db, "mistakes").some(
    (row) => row.fingerprint === input.fingerprint && row.source_event_id !== input.sourceEventId,
  );
  const existing = db
    .prepare("SELECT * FROM ozi_mistakes WHERE source_event_id=? AND fingerprint=?")
    .get(input.sourceEventId, input.fingerprint) as Mistake | undefined;
  const id = existing?.id ?? NodeCrypto.randomUUID();
  const trigger = correction?.id ?? (repeat ? input.sourceEventId : null);
  if (!existing)
    db.prepare(
      "INSERT INTO ozi_mistakes(id,at,thread,boundary,fingerprint,what,why,harness,status,source_event_id,trigger_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      DateTime.formatIso(Effect.runSync(DateTime.now)),
      sessionId,
      boundary?.id ?? null,
      input.fingerprint,
      input.what,
      input.why,
      session.snapshot,
      "logged",
      input.sourceEventId,
      trigger,
    );
  else if (existing.status === "logged" && trigger)
    db.prepare("UPDATE ozi_mistakes SET trigger_event_id=?,boundary=?,harness=? WHERE id=?").run(
      trigger,
      boundary?.id ?? null,
      session.snapshot,
      id,
    );
  return { id, status: existing?.status ?? "logged" };
}

const buildPaths = new Set(["system.md", "adhd.md", "skills", "protected"]);
export function inspect(root: string, selected = false) {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    const file = NodePath.join(root, relative);
    const stat = NodeFS.lstatSync(file);
    if (stat.isSymbolicLink()) return fail("symlink-denied");
    if (stat.isDirectory())
      for (const name of NodeFS.readdirSync(file)) visit(NodePath.join(relative, name));
    else if (stat.isFile()) files[relative] = sha(NodeFS.readFileSync(file));
    else fail("special-file-denied");
  };
  if (NodeFS.lstatSync(root).isSymbolicLink() || NodeFS.realpathSync(root) !== root)
    fail("symlink-denied");
  for (const name of NodeFS.readdirSync(root))
    if (name !== ".git" && (!selected || buildPaths.has(name))) visit(name);
  return files;
}
const same = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
function copyRoot(source: string, target: string) {
  inspect(source, true);
  NodeFS.mkdirSync(target, { recursive: true });
  for (const name of NodeFS.readdirSync(source))
    if (buildPaths.has(name))
      NodeFS.cpSync(NodePath.join(source, name), NodePath.join(target, name), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(target, "protected"), { recursive: true });
}
export async function withEngine<A>(
  root: string,
  state: string,
  run: (value: Awaited<ReturnType<typeof engine>>) => Promise<A>,
): Promise<A> {
  const value = await engine(root, state);
  const watcher = NodeFS.watch(state, () => {});
  try {
    return await run(value);
  } finally {
    watcher.close();
    await value.runtime.dispose();
    value.db.close();
  }
}
async function engine(root: string, state: string) {
  const db = openStore(state);
  const host = makeHost(root, state);
  await locked(root, async () => {
    inspect(root, true);
    if (!NodeFS.existsSync(NodePath.join(root, ".git"))) {
      for (const args of [
        ["init"],
        ["add", "--all"],
        [
          "-c",
          "user.name=Ozi",
          "-c",
          "user.email=ozi@localhost",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "-m",
          "chore: initialize data root",
        ],
      ]) {
        const result = await Effect.runPromise(host.run({ command: "git", cwd: root, args }));
        if (result.code !== 0) fail("git-failed");
      }
    }
  });
  const hostLayer = Layer.succeed(RepairHost, host);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Publication.layer, Sandbox.layer).pipe(
      Layer.provide(hostLayer),
      Layer.provide(sqlLayer(db)),
      Layer.provide(NodeServices.layer),
    ),
  );
  const activate = <A, E>(effect: Effect.Effect<A, E, Publisher>) =>
    locked(root, () => runtime.runPromise(effect));
  await activate(
    Effect.gen(function* () {
      yield* Publisher;
    }),
  );
  const blocker = (fix: Fix) => {
    if (fix.conflict && fix.state === "undone")
      db.prepare("INSERT OR IGNORE INTO ozi_blockers VALUES (?,?)").run(
        fix.id,
        `Undo conflict: predecessor active. User build saved at refs/ozi/user-builds/${fix.id}.`,
      );
  };
  for (const fix of list<Fix>(db, "fixes")) blocker(fix);
  const undo = async (id: string) => {
    const fix = await activate(Effect.flatMap(Publisher, (publisher) => publisher.undo(id)));
    blocker(fix);
    return fix;
  };
  return { db, host, runtime, activate, undo };
}

export async function work(root: string, state: string) {
  NodeFS.mkdirSync(state, { recursive: true, mode: 0o700 });
  await locked(NodePath.join(state, "worker"), () =>
    withEngine(root, state, async (engine) => {
      const { db, host, runtime, activate, undo } = engine;
      db.exec(
        "UPDATE ozi_mistakes SET status='failed' WHERE status='testing' AND id IN (SELECT id FROM ozi_replays WHERE state='running'); UPDATE ozi_replays SET state='failed',reason='interrupted',evidence_json='{\"failure\":{\"stage\":\"recovery\",\"cause\":\"Worker interrupted\"}}' WHERE state='running';",
      );
      for (const row of list<Mistake>(db, "mistakes").filter(
        (row) => row.status === "logged" && row.trigger_event_id,
      )) {
        const prior = list<Fix>(db, "fixes").findLast(
          (fix) =>
            list<Mistake>(db, "mistakes").some(
              (m) => m.id === fix.id && m.fingerprint === row.fingerprint,
            ) && ["shipped", "undone"].includes(fix.state),
        );
        if (prior) {
          if (prior.state === "shipped") await undo(prior.id);
          db.prepare("UPDATE ozi_mistakes SET trigger_event_id=NULL WHERE id=?").run(row.id);
          continue;
        }
        let session = db.prepare("SELECT * FROM ozi_sessions WHERE id=?").get(row.thread) as
          | Session
          | undefined;
        db.prepare("UPDATE ozi_mistakes SET status='testing' WHERE id=?").run(row.id);
        db.prepare("INSERT INTO ozi_replays(id,mistake_id,at,state) VALUES (?,?,?,'running')").run(
          row.id,
          row.id,
          DateTime.formatIso(Effect.runSync(DateTime.now)),
        );
        let phase = "source-settlement";
        const stages: Record<string, unknown> = {};
        try {
          if (session?.active) {
            try {
              session = await runtime.runPromise(
                Effect.callback<Session>((resume) => {
                  let finished = false;
                  const check = () => {
                    if (finished) return;
                    const current = db
                      .prepare("SELECT * FROM ozi_sessions WHERE id=?")
                      .get(row.thread) as Session | undefined;
                    if (current && !current.active) {
                      finished = true;
                      watcher.close();
                      resume(Effect.succeed(current));
                    }
                  };
                  const watcher = NodeFS.watch(state, check);
                  check();
                  return Effect.sync(() => {
                    finished = true;
                    watcher.close();
                  });
                }).pipe(Effect.timeout("90 seconds")),
              );
            } catch {
              fail("source-settlement-timeout");
            }
          }
          phase = "freeze";
          if (!session?.file || !row.boundary) fail("missing-native-history");
          const snapshot: SessionSnapshot = JSON.parse(session!.snapshot);
          const entries = snapshot.entries;
          const boundaryIndex = entries.findIndex((entry) => entry.id === row.boundary);
          if (boundaryIndex < 0) fail("missing-user-boundary");
          const boundary = entries[boundaryIndex]!;
          const sourceIndex = entries.findIndex((entry) => entry.id === row.source_event_id);
          const end = entries.findIndex(
            (entry, index) =>
              index > boundaryIndex && entry.type === "message" && entry.message.role === "user",
          );
          const turn = entries.slice(boundaryIndex + 1, end < 0 ? undefined : end);
          const effects = turn.flatMap((entry) =>
            entry.type === "message" && entry.message.role === "assistant"
              ? entry.message.content.flatMap((call) => {
                  if (call.type !== "toolCall") return [];
                  const result = turn.find(
                    (entry) =>
                      entry.type === "message" &&
                      entry.message.role === "toolResult" &&
                      entry.message.toolCallId === call.id,
                  );
                  if (!result || result.type !== "message" || result.message.role !== "toolResult")
                    return fail("unknown-effect");
                  const tool = snapshot.tools.find((tool) => tool.name === call.name);
                  if (!tool) return fail("unknown-effect");
                  return [
                    {
                      tool,
                      arguments: call.arguments,
                      result: {
                        content: result.message.content,
                        details: result.message.details,
                        isError: result.message.isError,
                      },
                    },
                  ];
                })
              : [],
          );
          const directory = NodePath.join(state, "repair", row.id);
          NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
          const frozen = NodePath.join(directory, "session.jsonl");
          if (
            NodeFS.realpathSync(session!.file!) !== session!.file! ||
            NodeFS.lstatSync(session!.file!).isSymbolicLink()
          )
            fail("history-path-denied");
          const native = NodeFS.readFileSync(session!.file!, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { id?: string });
          const nativeIndex = native.findIndex((entry) => entry.id === row.boundary);
          if (nativeIndex < 0) fail("missing-native-boundary");
          NodeFS.writeFileSync(
            frozen,
            native
              .slice(0, nativeIndex + 1)
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
            { mode: 0o400 },
          );
          const attachments: { file: string; mimeType: string; type: string }[] = [];
          if (
            boundary.type === "message" &&
            "content" in boundary.message &&
            Array.isArray(boundary.message.content)
          )
            for (const part of boundary.message.content)
              if (part.type === "image") {
                NodeFS.mkdirSync(NodePath.join(directory, "attachments"), { recursive: true });
                const file = String(attachments.length);
                NodeFS.writeFileSync(
                  NodePath.join(directory, "attachments", file),
                  Buffer.from(part.data, "base64"),
                  { mode: 0o400 },
                );
                attachments.push({ file, mimeType: part.mimeType, type: "image" });
              }
          const frozenCase = {
            dataRoot: root,
            messageId: row.boundary,
            text: textOf(boundary),
            expectation: textOf(
              entries.find((entry) => entry.id === row.trigger_event_id) ?? boundary,
            ),
            mistake: {
              what: row.what,
              why: row.why,
              fingerprint: row.fingerprint,
              sourceOutput: sourceIndex < 0 ? "" : textOf(entries[sourceIndex]!),
            },
            effects,
            attachments,
          };
          db.prepare("UPDATE ozi_replays SET case_json=? WHERE id=?").run(
            JSON.stringify(frozenCase),
            row.id,
          );
          const baseline = NodePath.join(directory, "baseline");
          const candidate = NodePath.join(directory, "candidate");
          await locked(root, async () => copyRoot(root, baseline));
          copyRoot(baseline, candidate);
          const original = inspect(baseline);
          const binary = await runtime.runPromise(host.resolveCommand("pi"));
          if (!binary) fail("missing-provider");
          const stage = async (
            name: "author" | "baseline" | "candidate" | "observer",
            caseEvidence: unknown,
          ) => {
            phase = name;
            let value;
            try {
              const exit = await runtime.runPromise(
                Effect.exit(
                  Effect.flatMap(RepairSandbox, (sandbox) =>
                    sandbox.run({
                      directory: NodePath.join(directory, `${name}-run`),
                      root: name === "baseline" || name === "observer" ? baseline : candidate,
                      protectedRoot: NodePath.join(baseline, "protected"),
                      frozen,
                      binary: binary!,
                      stage: name,
                      driver: "pi",
                      model: snapshot.model,
                      main: true,
                      message: frozenCase.text,
                      boundary: row.boundary!,
                      nativeId: session!.file!,
                      case: caseEvidence,
                      attachments,
                      effects,
                      tools: snapshot.tools,
                      options: [{ id: "thinking", value: snapshot.thinking }],
                      workerPrompt: "",
                    }),
                  ),
                ),
              );
              if (exit._tag === "Failure") {
                const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail");
                throw reason?._tag === "Fail" ? reason.error : new Error("sandbox-defect");
              }
              value = exit.value;
            } finally {
              if (name === "author") inspect(candidate);
            }
            stages[name] = value;
            db.prepare("UPDATE ozi_replays SET evidence_json=? WHERE id=?").run(
              JSON.stringify(stages),
              row.id,
            );
            return value;
          };
          await stage("author", frozenCase);
          phase = "publisher";
          const authored = inspect(candidate);
          const changed = [...new Set([...Object.keys(original), ...Object.keys(authored)])].filter(
            (name) => original[name] !== authored[name],
          );
          if (!changed.length) fail("publisher-empty-diff");
          if (
            changed.some(
              (name) =>
                !/^(?:system\.md|adhd\.md|skills\/[a-zA-Z0-9._/-]+)$/.test(name) ||
                name.split("/").some((part) => part === "." || part === ".."),
            )
          )
            fail("publisher-path-denied");
          const prompt = (dir: string) =>
            NodeFS.readFileSync(NodePath.join(dir, "system.md"), "utf8").replaceAll(
              "{{ADHD}}",
              NodeFS.existsSync(NodePath.join(dir, "adhd.md"))
                ? NodeFS.readFileSync(NodePath.join(dir, "adhd.md"), "utf8")
                : "",
            );
          if (prompt(candidate).trim().split(/\s+/u).length > 400)
            fail("publisher-prompt-too-long");
          const diff = await runtime.runPromise(
            host.run({
              command: "git",
              args: [
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--",
                baseline,
                candidate,
              ],
            }),
          );
          if (diff.code !== 1) fail("publisher-diff-failed");
          const base = await stage("baseline", frozenCase);
          const fixed = await stage("candidate", frozenCase);
          if (!same(original, inspect(baseline)) || !same(authored, inspect(candidate)))
            fail("replay-mutated-build");
          for (const [result, dir] of [
            [base, baseline],
            [fixed, candidate],
          ] as const) {
            if (result.evidence.unknown.length) fail("unknown-effect");
            if (
              !result.evidence.nativeFork ||
              result.evidence.prefixSha256 !== sha(NodeFS.readFileSync(frozen))
            )
              fail("missing-native-fork");
            if (result.evidence.loadout.systemPromptSha256 !== sha(prompt(dir)))
              fail("candidate-loadout-mismatch");
          }
          if (changed.some((name) => fixed.evidence.loadout.loaded[name] !== authored[name]))
            fail("candidate-loadout-mismatch");
          const observer = await stage("observer", {
            ...frozenCase,
            baseline: base.evidence,
            candidate: fixed.evidence,
            diff: diff.stdout,
          });
          if (!same(original, inspect(baseline)) || !same(authored, inspect(candidate)))
            fail("observer-mutated-build");
          phase = "observer-verdict";
          const text = observer.evidence.transcript.join("\n");
          const verdict = JSON.parse(
            [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)].at(-1)?.[1] ?? text,
          ) as {
            baselineReproduced?: boolean;
            candidatePassed?: boolean;
            agrees?: boolean;
            evidence?: string;
          };
          if (
            verdict.baselineReproduced !== true ||
            verdict.candidatePassed !== true ||
            verdict.agrees !== true ||
            !verdict.evidence?.trim()
          )
            fail("observer-verdict-invalid");
          db.prepare("UPDATE ozi_replays SET state='passed',evidence_json=? WHERE id=?").run(
            JSON.stringify({ ...stages, verdict, changed, diff: diff.stdout }),
            row.id,
          );
          phase = "publication";
          await activate(
            Effect.flatMap(Publisher, (publisher) =>
              publisher.publish({
                id: row.id,
                candidate,
                paths: changed,
                validate: (saved) =>
                  Effect.try({
                    try: () => {
                      if (
                        !same(original, inspect(root, true)) ||
                        !same(original, inspect(saved, true)) ||
                        !same(authored, inspect(candidate))
                      )
                        fail("publisher-build-changed");
                    },
                    catch: (cause) =>
                      new PublicationError({ reason: "publisher-build-changed", cause }),
                  }),
              }),
            ),
          );
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause);
          const reason = error.match(/Repair ([a-z-]+)\./)?.[1] ?? error.split("\n")[0]!;
          db.prepare(
            "UPDATE ozi_mistakes SET status='failed' WHERE id=? AND id NOT IN (SELECT id FROM ozi_fixes WHERE state IN ('publishing','shipped','undoing','undone'))",
          ).run(row.id);
          db.prepare(
            "UPDATE ozi_replays SET state='failed',reason=?,evidence_json=? WHERE id=?",
          ).run(
            reason,
            JSON.stringify({
              ...stages,
              failure: {
                stage: phase,
                cause: isRepairError(cause) ? (cause.cause ?? reason) : error,
              },
            }),
            row.id,
          );
        }
      }
    }),
  );
}
