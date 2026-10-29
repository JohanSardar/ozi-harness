import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { RepairHost } from "./RepairHost.ts";
import { RepairError } from "./RepairModel.ts";

export function makeHost(dataRoot: string, stateDir: string): RepairHost["Service"] {
  return {
    dataRoot,
    stateDir,
    environment: { ...process.env },
    executable: process.execPath,
    platform: process.platform,
    bridgeExtension: NodeModule.createRequire(import.meta.url).resolve(
      "pi-claude-bridge/src/index.ts",
    ),
    resolveCommand: (command) =>
      Effect.sync(() => {
        for (const dir of NodePath.isAbsolute(command)
          ? [""]
          : (process.env.PATH ?? "").split(NodePath.delimiter)) {
          const file = NodePath.resolve(dir, command);
          try {
            NodeFS.accessSync(file, NodeFS.constants.X_OK);
            return file;
          } catch {}
        }
        return undefined;
      }),
    run: (input) =>
      Effect.callback((resume) => {
        const child = NodeChildProcess.spawn(input.command, [...input.args], {
          cwd: input.cwd,
          env: { ...process.env, ...input.env },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: Duration.toMillis(Duration.fromInputUnsafe(input.timeout ?? "30 seconds")),
          killSignal: "SIGKILL",
        });
        let stdout = "";
        let stderr = "";
        let overflow = false;
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (Buffer.byteLength(stdout) > (input.maxOutputBytes ?? 1048576)) {
            overflow = true;
            child.kill("SIGKILL");
          }
        });
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-1048576);
        });
        child.on("error", (cause) =>
          resume(Effect.fail(new RepairError({ reason: "process-failed", cause }))),
        );
        child.on("close", (code, signal) =>
          resume(
            overflow
              ? Effect.fail(new RepairError({ reason: "output-limit" }))
              : Effect.succeed({ code, stdout, stderr, timedOut: signal === "SIGKILL" }),
          ),
        );
        return Effect.sync(() => {
          child.kill("SIGKILL");
        });
      }),
  };
}
