import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { piClaudeBridgeExtensionPath } from "@t3tools/provider-pi/server";
import { RepairHost } from "@ozi/pi/RepairHost";
import { RepairError } from "@ozi/pi/RepairModel";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export const repairHostLayer = Layer.effect(
  RepairHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runner = yield* ProcessRunner.ProcessRunner;
    const environment = yield* HostProcess.Environment;
    const executable = yield* HostProcess.ExecutablePath;
    const platform = yield* HostProcess.Platform;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return RepairHost.of({
      dataRoot: config.dataRoot,
      stateDir: config.stateDir,
      environment,
      executable,
      platform,
      bridgeExtension: piClaudeBridgeExtensionPath(),
      resolveCommand: (command) =>
        resolveCommandPath(command, { env: environment }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.map((value) => value ?? undefined),
          Effect.mapError((cause) => new RepairError({ reason: "missing-provider", cause })),
        ),
      run: (input) =>
        runner
          .run(input)
          .pipe(Effect.mapError((cause) => new RepairError({ reason: "process-failed", cause }))),
    });
  }),
);
