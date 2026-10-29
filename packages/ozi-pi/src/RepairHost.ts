import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { RepairError } from "./RepairModel.ts";

export const dataRootPermit = Semaphore.makeUnsafe(1);

export class RepairHost extends Context.Service<
  RepairHost,
  {
    dataRoot: string;
    stateDir: string;
    environment: NodeJS.ProcessEnv;
    executable: string;
    platform: string;
    bridgeExtension: string;
    resolveCommand: (command: string) => Effect.Effect<string | undefined, RepairError>;
    run: (input: {
      command: string;
      args: ReadonlyArray<string>;
      cwd?: string | undefined;
      env?: NodeJS.ProcessEnv | undefined;
      timeout?: Duration.Input | undefined;
      timeoutBehavior?: "timedOutResult";
      maxOutputBytes?: number;
    }) => Effect.Effect<
      { code: number | null; stdout: string; stderr: string; timedOut: boolean },
      RepairError
    >;
  }
>()("@ozi/pi/RepairHost") {}
