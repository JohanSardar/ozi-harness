import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export { dataRootPermit } from "@ozi/pi/RepairHost";

class DataRootError extends Schema.TaggedError<DataRootError>()("DataRootError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Failed to initialize the Ozi data root.";
  }
}

export class DataRoot extends Context.Service<
  DataRoot,
  { readonly initialize: Effect.Effect<void, DataRootError> }
>()("ozi/ozi/DataRoot") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const git = (args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args: [...args], cwd: config.dataRoot, timeout: "15 seconds" });
  const commit = (message: string, ...paths: ReadonlyArray<string>) =>
    git([
      "-c",
      "user.name=Ozi",
      "-c",
      "user.email=ozi@localhost",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=.git/hooks",
      "commit",
      "-m",
      message,
      ...(paths.length ? ["--", ...paths] : []),
    ]);
  const initialize = Effect.fn("DataRoot.initialize")(function* () {
    const entries = yield* fs
      .readDirectory(config.dataRoot)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed<Array<string>>([]) : Effect.fail(error),
        ),
      );
    if (entries.length > 0) {
      if (!entries.includes("prompt.md") || entries.includes("system.md")) return;
      if ((yield* git(["mv", "--", "prompt.md", "system.md"])).code !== 0)
        return yield* fs.rename(
          path.join(config.dataRoot, "prompt.md"),
          path.join(config.dataRoot, "system.md"),
        );
      const renamed = yield* commit("Rename prompt.md to system.md", "prompt.md", "system.md");
      if (renamed.code !== 0) return yield* new DataRootError({ cause: renamed.stderr });
      return;
    }
    const files = [
      "system.md",
      "protected/approvals.md",
      "protected/contacts.md",
      "protected/credentials.md",
    ];
    const contents = yield* Effect.forEach(files, (file) =>
      fs.readFileString(path.join(import.meta.dirname, "defaults", file)),
    );
    for (const directory of ["skills", "protected/cases"])
      yield* fs.makeDirectory(path.join(config.dataRoot, directory), { recursive: true });
    for (const [index, file] of files.entries())
      yield* fs.writeFileString(path.join(config.dataRoot, file), contents[index]!, { flag: "wx" });
    for (const step of [
      git(["init", "--initial-branch=main", "--template="]),
      git(["add", "--", ...files]),
      commit("Initialize Ozi data root"),
    ]) {
      const result = yield* step;
      if (result.code !== 0) return yield* new DataRootError({ cause: result.stderr });
    }
  });
  return DataRoot.of({
    initialize: initialize().pipe(Effect.mapError((cause) => new DataRootError({ cause }))),
  });
});

export const layer = Layer.effect(DataRoot, make);
