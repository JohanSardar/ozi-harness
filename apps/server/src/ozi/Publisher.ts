import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { dataRootPermit } from "./DataRoot.ts";
import { type Fix, RepairError } from "./RepairModel.ts";

export class Publisher extends Context.Service<
  Publisher,
  {
    readonly notify: Effect.Effect<boolean>;
    readonly subscribeChanges: () => Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly fixes: () => Effect.Effect<ReadonlyArray<Fix>, RepairError>;
    readonly publish: (input: {
      id: string;
      candidate: string;
      paths: ReadonlyArray<string>;
      validate: (snapshot: string) => Effect.Effect<void, RepairError>;
    }) => Effect.Effect<Fix, RepairError>;
    readonly undo: (id: string) => Effect.Effect<Fix, RepairError>;
  }
>()("ozi/ozi/Publisher") {}

const isRepairError = Schema.is(RepairError);
const normalized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isRepairError(cause) ? cause : new RepairError({ reason: "publication-failed", cause }),
    ),
  );
const decodePaths = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodePaths = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const permitted = (name: string) =>
  /^(?:system\.md|adhd\.md|skills\/[a-zA-Z0-9._/-]+)$/.test(name) &&
  !name.split("/").some((part) => part === "." || part === ".." || part === "");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* HostProcess.Environment;
  const changes = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  const notify = PubSub.publish(changes, undefined);
  const root = config.dataRoot;
  const directory = path.join(config.stateDir, "publications");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const git = Effect.fn("Publisher.git")(function* (
    cwd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ) {
    const result = yield* runner.run({
      command: "git",
      cwd,
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Ozi",
        "-c",
        "user.email=ozi@localhost",
        ...args,
      ],
      env,
      timeout: "30 seconds",
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.code !== 0)
      return yield* new RepairError({ reason: "git-failed", cause: result.stderr });
    return result.stdout.trim();
  });
  const fixes = Effect.fn("Publisher.fixes")(() =>
    normalized(sql<Fix>`SELECT * FROM ozi_fixes ORDER BY at, id`),
  );
  const lookup = Effect.fn("Publisher.lookup")(function* (id: string) {
    const rows = yield* sql<Fix>`SELECT * FROM ozi_fixes WHERE id = ${id}`;
    if (!rows[0]) return yield* new RepairError({ reason: "unknown-fix" });
    return rows[0];
  });
  const head = () =>
    runner
      .run({ command: "git", cwd: root, args: ["rev-parse", "--verify", "HEAD"] })
      .pipe(Effect.map((result) => (result.code === 0 ? result.stdout.trim() : null)));
  const checkpoint = Effect.fn("Publisher.checkpoint")(function* (fix: Fix, point: string) {
    const value = `${fix.state === "publishing" ? "publish" : "undo"}:${point}`;
    yield* sql`UPDATE ozi_fixes SET checkpoint = ${value} WHERE id = ${fix.id}`.pipe(
      Effect.andThen(notify),
    );
    if (environment.OZI_TEST_REPAIR_PAUSE === value) return yield* Effect.never;
  });
  const safe = Effect.fn("Publisher.safePath")(function* (base: string, name: string) {
    if (!permitted(name)) return yield* new RepairError({ reason: "publisher-path-denied" });
    if ((yield* fs.realPath(base)) !== base)
      return yield* new RepairError({ reason: "symlink-denied" });
    let current = base;
    for (const part of name.split("/")) {
      current = path.join(current, part);
      if (yield* fs.exists(current)) {
        if ((yield* fs.realPath(current)) !== current)
          return yield* new RepairError({ reason: "symlink-denied" });
        if (
          (yield* fs.stat(current)).type !==
          (current === path.join(base, name) ? "File" : "Directory")
        )
          return yield* new RepairError({ reason: "publisher-file-type-denied" });
      }
    }
    return current;
  });
  const copy = Effect.fn("Publisher.copy")(function* (
    source: string,
    target: string,
    names: ReadonlyArray<string>,
    inject?: Fix,
  ) {
    for (const name of names) {
      yield* safe(source, name);
      yield* safe(target, name);
    }
    for (const name of names) {
      const from = yield* safe(source, name);
      const to = yield* safe(target, name);
      if (yield* fs.exists(from)) {
        yield* fs.makeDirectory(path.dirname(to), { recursive: true });
        const temporary = yield* fs.makeTempFile({ directory: path.dirname(to), prefix: ".ozi-" });
        yield* fs
          .copyFile(from, temporary)
          .pipe(
            Effect.andThen(fs.rename(temporary, to)),
            Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          );
      } else yield* fs.remove(to, { force: true });
      if (inject) yield* checkpoint(inject, "file");
    }
  });
  const capture = Effect.fn("Publisher.capture")(function* (id: string, label: string) {
    const index = yield* fs.makeTempFile({ directory, prefix: "capture-" });
    yield* fs.remove(index, { force: true });
    const env = { GIT_INDEX_FILE: index };
    const previous = yield* head();
    if (previous) yield* git(root, ["read-tree", previous], env);
    yield* git(root, ["add", "--all", "--", "."], env);
    const tree = yield* git(root, ["write-tree"], env);
    const commit =
      previous && tree === (yield* git(root, ["rev-parse", `${previous}^{tree}`]))
        ? previous
        : yield* git(root, [
            "commit-tree",
            tree,
            ...(previous ? ["-p", previous] : []),
            "-m",
            "chore: preserve data-root build",
          ]);
    yield* git(root, ["update-ref", `refs/ozi/${label}/${id}`, commit]);
    return { commit, previous };
  });
  const worktree = Effect.fn("Publisher.worktree")(function* (
    id: string,
    label: string,
    commit: string,
  ) {
    const target = path.join(directory, `${id}-${label}`);
    if (yield* fs.exists(target)) yield* git(root, ["worktree", "remove", "--force", target]);
    yield* git(root, ["worktree", "add", "--detach", target, commit]);
    return target;
  });
  const setHead = Effect.fn("Publisher.setHead")(function* (commit: string) {
    const gitDir = yield* git(root, ["rev-parse", "--absolute-git-dir"]);
    const index = yield* fs.makeTempFile({ directory, prefix: "activation-" });
    yield* fs.remove(index, { force: true });
    yield* git(root, ["read-tree", commit], { GIT_INDEX_FILE: index });
    yield* git(root, ["update-ref", "HEAD", commit]);
    yield* fs.rename(index, path.join(gitDir, "index"));
  });
  const settle = Effect.fn("Publisher.settle")(function* (fix: Fix) {
    const names = yield* decodePaths(fix.paths_json);
    yield* copy(fix.snapshot, root, names, fix);
    yield* setHead(fix.target);
    yield* checkpoint(fix, "head");
    for (const name of names) {
      const source = path.join(fix.snapshot, name);
      const target = path.join(root, name);
      const exists = yield* fs.exists(source);
      if (
        exists !== (yield* fs.exists(target)) ||
        (exists && Buffer.compare(yield* fs.readFile(source), yield* fs.readFile(target)) !== 0)
      )
        return yield* new RepairError({ reason: "activation-unconfirmed" });
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = fix.state === "publishing" ? "shipped" : "undone";
        yield* sql`UPDATE ozi_fixes SET state = ${state}, error = NULL WHERE id = ${fix.id}`;
        yield* sql`UPDATE ozi_mistakes SET status = ${state} WHERE id = ${fix.id}`;
      }),
    );
    yield* checkpoint(fix, "settled");
    return yield* lookup(fix.id);
  });
  const activate = Effect.fn("Publisher.activate")(function* (fix: Fix, backup: string) {
    return yield* settle(fix).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* copy(backup, root, yield* decodePaths(fix.paths_json));
          if (fix.before_head) yield* setHead(fix.before_head);
          else yield* git(root, ["update-ref", "-d", "HEAD"]);
          const state = fix.state === "publishing" ? "failed" : "shipped";
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE ozi_fixes SET state = ${state}, error = 'activation-failed' WHERE id = ${fix.id}`;
              yield* sql`UPDATE ozi_mistakes SET status = ${state} WHERE id = ${fix.id}`;
            }),
          );
          return yield* Effect.fail(cause);
        }),
      ),
    );
  });
  const publish: Publisher["Service"]["publish"] = Effect.fn("Publisher.publish")((input) =>
    normalized(
      Effect.gen(function* () {
        const existing = (yield* fixes()).find((fix) => fix.id === input.id);
        if (existing) return existing;
        if (environment.OZI_TEST_REPAIR_PAUSE === "publish:prepared") {
          yield* sql`UPDATE ozi_replays SET reason = 'at:prepared' WHERE id = ${input.id}`.pipe(
            Effect.andThen(notify),
          );
          return yield* Effect.never;
        }
        if (!input.paths.length || input.paths.some((name) => !permitted(name)))
          return yield* new RepairError({ reason: "publisher-path-denied" });
        const before = yield* capture(input.id, "predecessors");
        const backup = yield* worktree(input.id, "before", before.commit);
        yield* input.validate(backup);
        const candidate = yield* worktree(input.id, "publish", before.commit);
        yield* copy(input.candidate, candidate, input.paths);
        yield* git(candidate, ["add", "--all"]);
        yield* git(candidate, ["commit", "-m", `fix: repair ${input.id}`]);
        const commit = yield* git(candidate, ["rev-parse", "HEAD"]);
        const actual = (yield* git(candidate, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          commit,
        ])).split("\n");
        if (
          actual.length !== input.paths.length ||
          actual.some((name) => !input.paths.includes(name) || !permitted(name))
        )
          return yield* new RepairError({ reason: "publisher-diff-mismatch" });
        yield* git(root, ["update-ref", `refs/ozi/fixes/${input.id}`, commit]);
        yield* sql`INSERT INTO ozi_fixes (id, at, commit_sha, predecessor, state, before_head, target, snapshot, paths_json) VALUES (${input.id}, ${DateTime.formatIso(yield* DateTime.now)}, ${commit}, ${before.commit}, 'publishing', ${before.previous}, ${commit}, ${candidate}, ${yield* encodePaths(input.paths)})`;
        const fix = yield* lookup(input.id);
        yield* checkpoint(fix, "journal");
        return yield* activate(fix, backup);
      }),
    ).pipe(dataRootPermit.withPermits(1), Effect.ensuring(notify), Effect.uninterruptible),
  );
  const undo: Publisher["Service"]["undo"] = Effect.fn("Publisher.undo")((id) =>
    normalized(
      Effect.gen(function* () {
        const fix = yield* lookup(id);
        if (fix.state === "undone") return fix;
        if (fix.state !== "shipped") return yield* new RepairError({ reason: "fix-not-active" });
        const names = yield* decodePaths(fix.paths_json);
        for (const name of names) yield* safe(root, name);
        const before = yield* capture(id, "user-builds");
        const backup = yield* worktree(id, "undo-before", before.commit);
        const candidate = yield* worktree(id, "undo", before.commit);
        const result = yield* runner.run({
          command: "git",
          cwd: candidate,
          args: [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Ozi",
            "-c",
            "user.email=ozi@localhost",
            "revert",
            "--no-edit",
            fix.commit_sha,
          ],
        });
        let conflict = 0;
        if (result.code !== 0) {
          if (!(yield* git(candidate, ["ls-files", "--unmerged"])))
            return yield* new RepairError({ reason: "revert-failed", cause: result.stderr });
          yield* git(candidate, ["revert", "--abort"]);
          const predecessor = path.join(directory, `${id}-before`);
          yield* copy(predecessor, candidate, names);
          yield* git(candidate, ["add", "--all"]);
          yield* git(candidate, [
            "commit",
            "--allow-empty",
            "-m",
            `fix: restore predecessor of ${fix.commit_sha}`,
          ]);
          conflict = 1;
        }
        const target = yield* git(candidate, ["rev-parse", "HEAD"]);
        const changed = (yield* git(candidate, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          target,
        ]))
          .split("\n")
          .filter(Boolean);
        if (changed.some((name) => !names.includes(name) || !permitted(name)))
          return yield* new RepairError({ reason: "undo-path-denied" });
        yield* sql`UPDATE ozi_fixes SET state = 'undoing', before_head = ${before.previous}, target = ${target}, snapshot = ${candidate}, conflict = ${conflict}, checkpoint = NULL WHERE id = ${id}`;
        const pending = yield* lookup(id);
        yield* checkpoint(pending, "journal");
        return yield* activate(pending, backup);
      }),
    ).pipe(dataRootPermit.withPermits(1), Effect.ensuring(notify), Effect.uninterruptible),
  );
  yield* normalized(
    Effect.gen(function* () {
      for (const fix of yield* fixes()) {
        if (fix.state !== "publishing" && fix.state !== "undoing") continue;
        const backup = path.join(
          directory,
          `${fix.id}-${fix.state === "publishing" ? "before" : "undo-before"}`,
        );
        yield* activate(fix, backup);
      }
      yield* sql`UPDATE ozi_mistakes SET status = 'failed' WHERE status = 'testing' AND id IN (SELECT mistake_id FROM ozi_replays WHERE state = 'passed') AND id NOT IN (SELECT id FROM ozi_fixes)`;
    }),
  ).pipe(dataRootPermit.withPermits(1));
  return Publisher.of({
    fixes,
    publish,
    undo,
    notify,
    subscribeChanges: () => PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(Publisher, make);
