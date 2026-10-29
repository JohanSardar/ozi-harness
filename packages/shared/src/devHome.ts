import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export const resolveCheckoutPath = Effect.fn("devHome.resolveCheckoutPath")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = path.resolve(cwd);
  for (;;) {
    if (Option.isSome(yield* fileSystem.stat(path.join(directory, ".git")).pipe(Effect.option)))
      return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
});

export const resolveCheckoutHome = Effect.fn("devHome.resolveCheckoutHome")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const checkout = yield* resolveCheckoutPath(cwd);
  return checkout === undefined ? undefined : (yield* Path.Path).join(checkout, ".ozi");
});
