import {
  ThreadId,
  CommandId,
  OZI_MAIN_THREAD_ID,
  ProviderInstanceId,
  OrchestrationV2ProviderThreadJson,
  ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { piMainAgentDir } from "@t3tools/provider-pi/server";
import * as ServerConfig from "../config.ts";
import type { McpThreadCaller } from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  type Fix,
  type LogMistake,
  type Mistake,
  type Replay,
  RepairError,
} from "./RepairModel.ts";
import * as Publisher from "./Publisher.ts";
import { dataRootPermit } from "./DataRoot.ts";
import * as RepairSandbox from "./RepairSandbox.ts";
import { mcpTools } from "./McpTools.ts";
import { OZI_WORKER_ROLE } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as RepairTasks from "./RepairTasks.ts";
import { readMainPrompt } from "./Loadout.ts";
import { verdictText } from "./verdictText.ts";

type Caller = Pick<McpThreadCaller, "threadId" | "providerInstanceId"> & {
  readonly origin: "agent" | "runtime";
};
type Frozen = {
  messageId: string;
  text: string;
  expectation: string;
  mistake: {
    fingerprint: string;
    what: string;
    why: string;
    sourceEventId: string;
    sourceOutput: string;
  };
  nativeId: string;
  boundary: string;
  driver: string;
  model: string;
  instanceId: ProviderInstanceId;
  main: boolean;
  attachments: ReadonlyArray<{
    file: string;
    name: string;
    mimeType: string;
    type: string;
    sha256: string;
  }>;
  effects: ReadonlyArray<{ tool: unknown; arguments: unknown; result: unknown }>;
  tools: ReadonlyArray<unknown>;
  options: ModelSelection["options"];
};

const HarnessJson = Schema.fromJsonString(
  Schema.Struct({
    providerThread: Schema.NullOr(OrchestrationV2ProviderThreadJson),
    selection: ModelSelection,
    nativeTurnId: Schema.NullOr(Schema.String),
  }),
);

const isRepairError = Schema.is(RepairError);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHarness = Schema.decodeEffect(HarnessJson);
const encodeHarness = Schema.encodeEffect(HarnessJson);
const decodeProviderConfig = Schema.decodeUnknownEffect(
  Schema.Struct({ binaryPath: Schema.optional(Schema.String) }),
);
const decodeVerdict = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      baselineReproduced: Schema.Literal(true),
      candidatePassed: Schema.Literal(true),
      agrees: Schema.Literal(true),
      evidence: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
);

export class Repair extends Context.Service<
  Repair,
  {
    readonly logMistake: (
      input: LogMistake,
      caller: Caller,
    ) => Effect.Effect<{ id: string; status: Mistake["status"] }, RepairError>;
    readonly mistakes: (id?: string) => Effect.Effect<ReadonlyArray<Mistake>, RepairError>;
    readonly replays: () => Effect.Effect<ReadonlyArray<Replay>, RepairError>;
    readonly fixes: () => Effect.Effect<ReadonlyArray<Fix>, RepairError>;
    readonly undo: (id: string) => Effect.Effect<Fix, RepairError>;
    readonly subscribe: (
      entity: "mistake" | "replay" | "fix",
      id: string,
    ) => Stream.Stream<Mistake | Replay | Fix | null, RepairError>;
    readonly events: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, RepairError>;
    readonly changeProtectedRule: (
      input: { correctionMessageId: string; path: string; content: string },
      caller: Caller,
    ) => Effect.Effect<{ changed: true }, RepairError>;
  }
>()("ozi/ozi/Repair") {}

const digest = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)).pipe(
    Effect.map((value) => Buffer.from(value).toString("hex")),
  );
const encode = (text: string) => new TextEncoder().encode(text);
const fail = (reason: string, cause?: unknown) => new RepairError({ reason, cause });
const sameTree = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(before).length === Object.keys(after).length &&
  Object.entries(before).every(([name, hash]) => after[name] === hash);
const normalized = <A, E, R>(effect: Effect.Effect<A, E, R>, reason = "operation-failed") =>
  effect.pipe(
    Effect.mapError((cause) => (isRepairError(cause) ? cause : new RepairError({ reason, cause }))),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ids = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const events = yield* Events.OrchestrationEventStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sandbox = yield* RepairSandbox.RepairSandbox;
  const repairTasks = yield* RepairTasks.RepairTasks;
  const publisher = yield* Publisher.Publisher;
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const runner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* HostProcess.Environment;
  const hostHome = yield* HostProcess.HomeDirectory;
  const queue = yield* Queue.unbounded<string>();
  const publish = publisher.notify;
  const logPermit = Semaphore.makeUnsafe(1);
  const root = path.join(config.stateDir, "repair");
  const readPrompt = (dataRoot: string) =>
    readMainPrompt({ ...config, dataRoot }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });

  const mistakes = Effect.fn("Repair.mistakes")((id?: string) =>
    normalized(
      id === undefined
        ? sql<Mistake>`SELECT * FROM ozi_mistakes ORDER BY at, id`
        : sql<Mistake>`SELECT * FROM ozi_mistakes WHERE id = ${id}`,
    ),
  );
  const replays = Effect.fn("Repair.replays")(() =>
    normalized(sql<Replay>`SELECT * FROM ozi_replays ORDER BY at, id`),
  );
  const sourceEvents = (threadId: string) =>
    events.readAgentEvents({ threadId: ThreadId.make(threadId) }).pipe(Stream.runCollect);
  const eventById = Effect.fn("Repair.sourceEvent")(function* (id: string) {
    const rows = yield* sql<{
      stream_id: string;
    }>`SELECT stream_id FROM orchestration_events WHERE event_id = ${id}`;
    return rows[0]
      ? (yield* sourceEvents(rows[0].stream_id)).find((value) => value.event.id === id)
      : undefined;
  });
  const projection = (id: string) =>
    threads.getThreadSnapshot(ThreadId.make(id)).pipe(Effect.map((value) => value.projection));
  const userAuthored = (message: OrchestrationV2ConversationMessage) =>
    message.role === "user" &&
    message.createdBy === "user" &&
    ["cli", "web"].includes(message.creationSource) &&
    message.scheduledTaskId === undefined;
  const messageById = Effect.fn("Repair.messageById")(function* (id: string) {
    const rows = yield* sql<{
      event_id: string;
    }>`SELECT event_id FROM orchestration_events WHERE event_type = 'message.updated' AND json_extract(payload_json, '$.id') = ${id} ORDER BY sequence LIMIT 1`;
    return rows[0] ? yield* eventById(rows[0].event_id) : undefined;
  });

  const rejectLink = Effect.fn("Repair.rejectLink")(function* (file: string) {
    const target = yield* fs.readLink(file).pipe(
      Effect.catchIf(
        (error) =>
          error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL",
        () => Effect.succeed(undefined),
      ),
    );
    if (target !== undefined) return yield* fail("symlink-denied", { path: file, target });
  });

  const copyTree = Effect.fn("Repair.copyTree")(function* (source: string, target: string) {
    yield* fs.makeDirectory(target, { recursive: true });
    const visit = Effect.fn("Repair.copyEntry")(function* (
      relative: string,
    ): Effect.fn.Return<void, PlatformError | RepairError> {
      const sourcePath = path.join(source, relative);
      yield* rejectLink(sourcePath);
      const stat = yield* fs.stat(sourcePath);
      const resolved = yield* fs.realPath(sourcePath);
      if (resolved !== sourcePath) return yield* fail("symlink-denied");
      if (stat.type === "Directory") {
        yield* fs.makeDirectory(path.join(target, relative), { recursive: true });
        for (const name of yield* fs.readDirectory(sourcePath))
          if (name !== ".git") yield* visit(path.join(relative, name));
      } else if (stat.type === "File") yield* fs.copyFile(sourcePath, path.join(target, relative));
      else return yield* fail("special-file-denied");
    });
    const entries = yield* fs.readDirectory(source);
    for (const name of ["system.md", "adhd.md", "skills", "protected"])
      if (entries.includes(name)) yield* visit(name);
    yield* fs.makeDirectory(path.join(target, "protected"), { recursive: true });
  });

  const tree = Effect.fn("Repair.tree")(function* (directory: string) {
    const names: string[] = [];
    const visit = Effect.fn("Repair.inspectEntry")(function* (
      relative: string,
    ): Effect.fn.Return<void, PlatformError | RepairError> {
      const file = path.join(directory, relative);
      yield* rejectLink(file);
      if (yield* fs.realPath(file).pipe(Effect.map((resolved) => resolved !== file)))
        return yield* fail("symlink-denied");
      const stat = yield* fs.stat(file);
      if (stat.type === "Directory") {
        for (const name of yield* fs.readDirectory(file)) yield* visit(path.join(relative, name));
      } else if (stat.type === "File") names.push(relative);
      else return yield* fail("special-file-denied");
    });
    for (const name of yield* fs.readDirectory(directory)) yield* visit(name);
    const files: Record<string, string> = {};
    for (const name of names)
      files[name] = yield* digest(yield* fs.readFile(path.join(directory, name)));
    return files;
  });

  const freeze = Effect.fn("Repair.freeze")(function* (
    row: Mistake,
    current: OrchestrationV2ThreadProjection,
    directory: string,
  ) {
    const message = current.messages.find((message) => message.id === row.boundary);
    if (!message || message.role !== "user") return yield* fail("missing-user-boundary");
    const harness = yield* decodeHarness(row.harness);
    const provider = harness.providerThread;
    if (
      !provider?.nativeThreadRef ||
      provider.nativeThreadRef.strength !== "strong" ||
      !provider.nativeThreadRef.nativeId
    )
      return yield* fail("missing-native-history");
    const driver = provider.driver;
    const nativeId = provider.nativeThreadRef.nativeId;
    const providerHome =
      environment[
        driver === "pi"
          ? "PI_CODING_AGENT_DIR"
          : driver === "codex"
            ? "CODEX_HOME"
            : "CLAUDE_CONFIG_DIR"
      ] ??
      path.join(
        hostHome,
        driver === "pi" ? ".pi/agent" : driver === "codex" ? ".codex" : ".claude",
      );
    const home = yield* fs.realPath(
      driver === "pi" && harness.selection.model.startsWith("claude-bridge/")
        ? piMainAgentDir(config.providerStatusCacheDir)
        : providerHome,
    );
    const locate = Effect.fn("Repair.locateHistory")(function* (
      directory: string,
    ): Effect.fn.Return<string[], PlatformError> {
      const found: string[] = [];
      for (const name of yield* fs.readDirectory(directory)) {
        const file = path.join(directory, name);
        if ((yield* fs.realPath(file)) !== file) continue;
        const stat = yield* fs.stat(file);
        if (stat.type === "Directory") found.push(...(yield* locate(file)));
        else if (name.endsWith(".jsonl") && name.includes(nativeId)) found.push(file);
      }
      return found;
    });
    let source = driver === "pi" ? nativeId : path.join(home, `${nativeId}.jsonl`);
    if (!(yield* fs.exists(source))) {
      const sources = yield* locate(path.join(home, driver === "codex" ? "sessions" : "projects"));
      if (sources.length !== 1) return yield* fail("missing-native-history");
      source = sources[0]!;
    }
    const sourcePath = yield* fs.realPath(source);
    if (!sourcePath.startsWith(home + path.sep)) return yield* fail("history-path-denied");
    const content = yield* fs.readFileString(sourcePath);
    const decode = decodeJson;
    const records = yield* Effect.forEach(content.trim().split("\n"), (value) => decode(value));
    const native = records as Array<{
      type?: string;
      id?: string;
      uuid?: string;
      payload?: { turn_id?: string };
      message?: {
        role?: string;
        toolCallId?: string;
        isError?: boolean;
        details?: unknown;
        content?:
          | string
          | Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
      };
      turns?: Array<{ id: string }>;
    }>;
    const nativeTurnId = harness.nativeTurnId;
    let index = native.findLastIndex(
      (entry) =>
        entry.message?.role === "user" &&
        (typeof entry.message.content === "string"
          ? entry.message.content.includes(message.text)
          : entry.message.content?.some(
              (part) => part.type === "text" && part.text?.includes(message.text),
            )),
    );
    let boundary = "";
    let prefix = records;
    if (driver === "pi") {
      if (nativeTurnId) index = native.findIndex((entry) => entry.id === nativeTurnId);
      if (index < 0 || !native[index]?.id) return yield* fail("missing-native-boundary");
      boundary = native[index]!.id!;
      prefix = records.slice(0, index + 1);
    } else if (driver === "codex") {
      const turns = native[0]?.turns;
      if (turns) {
        index = turns.findIndex((turn) => turn.id === nativeTurnId);
        if (index < 0) return yield* fail("missing-native-boundary");
        boundary = turns[index - 1]?.id ?? "";
        prefix = [{ ...native[0], turns: turns.slice(0, index) }];
      } else {
        index = native.findIndex(
          (entry) => entry.type === "turn_context" && entry.payload?.turn_id === nativeTurnId,
        );
        if (index < 0) return yield* fail("missing-native-boundary");
        prefix = records.slice(0, index);
        boundary =
          native.slice(0, index).findLast((entry) => entry.type === "turn_context")?.payload
            ?.turn_id ?? "";
      }
    } else {
      if (index < 0 || !native[index]?.uuid) return yield* fail("missing-native-boundary");
      prefix = records.slice(0, index);
      boundary = native.slice(0, index).findLast((entry) => entry.type === "assistant")?.uuid ?? "";
    }
    const trigger = row.trigger_event_id
      ? (yield* eventById(row.trigger_event_id))?.event
      : undefined;
    const sourceEvent = (yield* eventById(row.source_event_id))?.event;
    const attachments: Frozen["attachments"][number][] = [];
    const effects: Frozen["effects"][number][] = [];
    const tools = (current.thread.effectiveLoadout?.toolNames ?? []).flatMap((name) =>
      mcpTools.has(name) ? [mcpTools.get(name)!] : [],
    );
    const end = native.findIndex(
      (entry, position) => position > index && entry.message?.role === "user",
    );
    for (const entry of native.slice(index + 1, end < 0 ? undefined : end)) {
      if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
      for (const call of entry.message.content.filter((part) => part.type === "toolCall")) {
        if (!call.name || call.name === "read_skill") continue;
        const result = native.find(
          (entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === call.id,
        )?.message;
        if (!result) return yield* fail("unknown-effect");
        effects.push({
          tool: mcpTools.get(call.name) ?? {
            name: call.name,
            description: "Frozen effect.",
            inputSchema: { type: "object", additionalProperties: true },
          },
          arguments: call.arguments ?? {},
          result: {
            content: result.content,
            structuredContent: result.details,
            isError: result.isError ?? false,
          },
        });
      }
    }
    const nativeContent = native[index]?.message?.content;
    let text =
      typeof nativeContent === "string"
        ? nativeContent
        : (nativeContent
            ?.filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n") ?? message.text);
    if (message.attachments.length) yield* fs.makeDirectory(path.join(directory, "attachments"));
    for (const attachment of message.attachments) {
      const source = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (!source || (yield* fs.realPath(source)) !== source)
        return yield* fail("missing-attachment");
      const file = String(attachments.length);
      const bytes = yield* fs.readFile(source);
      yield* fs.writeFile(path.join(directory, "attachments", file), bytes, { mode: 0o400 });
      attachments.push({
        file,
        name: attachment.name,
        mimeType: attachment.mimeType,
        type: attachment.type,
        sha256: yield* digest(bytes),
      });
      text = text.replaceAll(source, `/case/attachments/${file}`);
    }
    const frozen: Frozen = {
      messageId: message.id,
      text,
      expectation:
        trigger?.type === "message.updated" &&
        trigger.payload.role === "user" &&
        trigger.payload.createdBy === "user"
          ? trigger.payload.text
          : message.text,
      mistake: {
        fingerprint: row.fingerprint,
        what: row.what,
        why: row.why,
        sourceEventId: row.source_event_id,
        sourceOutput: sourceEvent?.type === "message.updated" ? sourceEvent.payload.text : row.what,
      },
      nativeId,
      boundary,
      driver,
      model: harness.selection.model,
      instanceId: harness.selection.instanceId,
      main: current.thread.role === "main" || current.thread.role === "main-fork",
      attachments,
      effects,
      tools,
      options: harness.selection.options,
    };
    const session = path.join(directory, "session.jsonl");
    yield* fs.writeFileString(
      session,
      (yield* Effect.forEach(prefix, (entry) => encodeJson(entry))).join("\n") + "\n",
      { mode: 0o400 },
    );
    return { frozen, session };
  });

  const blocker = Effect.fn("Repair.undoBlocker")(function* (fix: Fix) {
    if (!fix.conflict || fix.state !== "undone") return;
    const current = yield* projection(OZI_MAIN_THREAD_ID);
    const parentRun = current.runs.findLast((run) => run.rootNodeId !== null);
    if (!parentRun?.rootNodeId) return yield* fail("missing-blocker-boundary");
    yield* threads.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`ozi-undo-blocker:${fix.id}`),
      parentThreadId: current.thread.id,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId,
      task: `Resolve undo conflict for fix ${fix.id}. The pre-fix build is active. The user version is preserved at refs/ozi/user-builds/${fix.id}.`,
      title: "Fix undo conflict",
      modelSelection: current.thread.modelSelection,
      runtimeMode: current.thread.runtimeMode,
      interactionMode: "default",
      createdBy: "system",
      creationSource: "server",
      launchFailure: `Undo conflict for fix ${fix.id}. The pre-fix build is active. Recover the user version from refs/ozi/user-builds/${fix.id}.`,
    });
  });
  const undo = Effect.fn("Repair.undo")((id: string) =>
    normalized(
      Effect.gen(function* () {
        const fix = yield* publisher.undo(id);
        yield* blocker(fix);
        return fix;
      }),
    ),
  );

  const run = Effect.fn("Repair.run")(function* (id: string) {
    const row = (yield* mistakes(id))[0];
    if (!row || row.status !== "logged") return;
    const fixed =
      yield* sql<Fix>`SELECT f.* FROM ozi_fixes f JOIN ozi_mistakes m ON m.id = f.id WHERE m.fingerprint = ${row.fingerprint} AND f.state IN ('shipped', 'undone') ORDER BY f.at DESC LIMIT 1`;
    if (fixed[0]) {
      if (fixed[0].state === "shipped") yield* undo(fixed[0].id);
      yield* sql`UPDATE ozi_mistakes SET trigger_event_id = NULL WHERE id = ${id}`;
      return;
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE ozi_mistakes SET status = 'testing' WHERE id = ${id}`;
          yield* sql`INSERT INTO ozi_replays (id, mistake_id, at, state) VALUES (${id}, ${id}, ${at}, 'running') ON CONFLICT DO NOTHING`;
        }),
      )
      .pipe(Effect.andThen(publish));
    let phase = "source-settlement";
    const test = Effect.gen(function* () {
      const directory = path.join(root, id);
      yield* fs.makeDirectory(directory, { recursive: true });
      const current = yield* projection(row.thread);
      const settled = yield* threads.waitForThread({
        projectId: current.thread.projectId,
        threadId: current.thread.id,
        timeoutMs: 90000,
      });
      if (settled.timedOut) return yield* fail("source-settlement-timeout", settled);
      phase = "freeze";
      const { frozen, session } = yield* freeze(row, current, directory);
      yield* sql`UPDATE ozi_replays SET case_json = ${yield* encodeJson(frozen)} WHERE id = ${id}`.pipe(
        Effect.andThen(publish),
      );
      const baseline = path.join(directory, "baseline");
      const candidate = path.join(directory, "candidate");
      phase = "snapshot";
      yield* copyTree(config.dataRoot, baseline).pipe(dataRootPermit.withPermits(1));
      yield* copyTree(baseline, candidate);
      const original = yield* tree(baseline);
      let authored = original;
      const instance = (yield* settings.getSettings).providerInstances[frozen.instanceId];
      const providerConfig = yield* decodeProviderConfig(instance?.config ?? {});
      const binary = providerConfig.binaryPath ?? frozen.driver;
      const stages: Record<string, unknown> = {};
      const stage = Effect.fn("Repair.stage")(function* (
        name: "author" | "baseline" | "candidate" | "observer",
        caseEvidence: unknown,
      ) {
        phase = name;
        const parent = yield* projection(OZI_MAIN_THREAD_ID);
        const parentRun = parent.runs.findLast(
          (run) => run.rootNodeId !== null && run.status !== "queued",
        );
        if (!parentRun?.rootNodeId) return yield* fail("missing-delegation-boundary");
        const commandId = CommandId.make(`ozi-repair:${id}:${name}`);
        const childThreadId = allocator.derive.delegatedTaskThread({ commandId });
        const result = yield* repairTasks.register({
          commandId,
          threadId: childThreadId,
          parentThreadId: parent.thread.id,
          run: sandbox
            .run({
              directory: path.join(directory, name + "-run"),
              root: name === "baseline" || name === "observer" ? baseline : candidate,
              protectedRoot: path.join(baseline, "protected"),
              frozen: session,
              binary,
              stage: name,
              driver: frozen.driver,
              model: frozen.model,
              main: frozen.main,
              message: frozen.text,
              boundary: frozen.boundary,
              nativeId: frozen.nativeId,
              case: caseEvidence,
              attachments: frozen.attachments,
              effects: frozen.effects,
              tools: frozen.tools,
              options: frozen.options ?? [],
              workerPrompt: OZI_WORKER_ROLE,
            })
            .pipe(
              Effect.onExit(() =>
                name === "author"
                  ? normalized(tree(candidate), "publisher-inspection-failed").pipe(
                      Effect.tap((files) =>
                        Effect.sync(() => {
                          authored = files;
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            ),
        });
        yield* threads.dispatch({
          type: "delegated_task.request",
          commandId,
          parentThreadId: parent.thread.id,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: `Repair ${name}: ${id}`,
          title: `Repair ${name}`,
          modelSelection: {
            instanceId: frozen.instanceId,
            model: frozen.model,
            options: frozen.options ?? [],
          },
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: "default",
          createdBy: "system",
          creationSource: "server",
        });
        const value = yield* result.pipe(
          Effect.timeout("90 seconds"),
          Effect.catchTags({
            TimeoutError: (cause) => fail("stage-timeout", cause),
          }),
        );
        const completed = yield* threads.waitForThread({
          projectId: parent.thread.projectId,
          threadId: childThreadId,
          timeoutMs: 15000,
        });
        if (completed.timedOut) return yield* fail("stage-settlement-timeout", completed);
        if (completed.run?.status !== "completed") return yield* fail("delegated-repair-failed");
        const output = { ...value, childThreadId };
        stages[name] = output;
        yield* sql`UPDATE ozi_replays SET evidence_json = ${yield* encodeJson(stages)} WHERE id = ${id}`.pipe(
          Effect.andThen(publish),
        );
        return output;
      });
      const author = yield* stage("author", {
        ...frozen,
        fingerprint: row.fingerprint,
        what: row.what,
        why: row.why,
      });
      phase = "publisher";
      const changed = [...new Set([...Object.keys(original), ...Object.keys(authored)])].filter(
        (name) => original[name] !== authored[name],
      );
      if (changed.length === 0) return yield* fail("publisher-empty-diff");
      const candidateText = yield* readPrompt(candidate);
      if (candidateText.trim().split(/\s+/u).filter(Boolean).length > 400)
        return yield* fail("publisher-prompt-too-long");
      if (
        changed.some(
          (name) =>
            name.startsWith("protected/") ||
            !/^(?:system\.md|adhd\.md|skills\/[a-zA-Z0-9._/-]+)$/.test(name) ||
            name.split("/").includes(".."),
        )
      )
        return yield* fail("publisher-path-denied");
      const diff = yield* runner.run({
        command: "git",
        args: ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", baseline, candidate],
      });
      if (diff.code !== 1) return yield* fail("publisher-diff-failed");
      const base = yield* stage("baseline", frozen);
      const fixed = yield* stage("candidate", frozen);
      if (!sameTree(original, yield* tree(baseline)) || !sameTree(authored, yield* tree(candidate)))
        return yield* fail("replay-mutated-build");
      if (base.evidence.unknown.length || fixed.evidence.unknown.length)
        return yield* fail("unknown-effect");
      if (!base.evidence.nativeFork || !fixed.evidence.nativeFork)
        return yield* fail("missing-native-fork");
      const basePrompt = yield* digest(
        encode(frozen.main ? yield* readPrompt(baseline) : OZI_WORKER_ROLE),
      );
      const candidatePrompt = yield* digest(encode(frozen.main ? candidateText : OZI_WORKER_ROLE));
      const prefix = yield* digest(yield* fs.readFile(session));
      if (
        base.evidence.loadout.systemPromptSha256 !== basePrompt ||
        fixed.evidence.loadout.systemPromptSha256 !== candidatePrompt ||
        base.evidence.prefixSha256 !== prefix ||
        fixed.evidence.prefixSha256 !== prefix ||
        changed.some((name) => fixed.evidence.loadout.loaded[name] !== authored[name])
      )
        return yield* fail("candidate-loadout-mismatch");
      const observer = yield* stage("observer", {
        ...frozen,
        baseline: base.evidence,
        candidate: fixed.evidence,
        diff: diff.stdout,
      });
      if (!sameTree(original, yield* tree(baseline)) || !sameTree(authored, yield* tree(candidate)))
        return yield* fail("observer-mutated-build");
      phase = "observer-verdict";
      const verdict = yield* decodeVerdict(
        verdictText(observer.evidence.transcript.join("\n")),
      ).pipe(Effect.mapError((cause) => fail("observer-verdict-invalid", cause)));
      const evidence = {
        author,
        baseline: base,
        candidate: fixed,
        observer,
        verdict,
        changed,
        diff: diff.stdout,
        publication: "local",
      };
      yield* sql`UPDATE ozi_replays SET state = 'passed', evidence_json = ${yield* encodeJson(evidence)} WHERE id = ${id} AND state = 'running'`.pipe(
        Effect.andThen(publish),
      );
      phase = "publication";
      yield* publisher.publish({
        id,
        candidate,
        paths: changed,
        validate: (snapshot) =>
          normalized(
            Effect.gen(function* () {
              const live = path.join(directory, "publication-baseline");
              const saved = path.join(directory, "publication-snapshot");
              yield* copyTree(config.dataRoot, live);
              yield* copyTree(snapshot, saved);
              if (
                !sameTree(original, yield* tree(live)) ||
                !sameTree(original, yield* tree(saved)) ||
                !sameTree(authored, yield* tree(candidate))
              )
                return yield* fail("publisher-build-changed");
            }),
          ),
      });
    });
    yield* test.pipe(
      Effect.catchCause((cause) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE ozi_mistakes SET status = 'failed' WHERE id = ${id} AND id NOT IN (SELECT id FROM ozi_fixes WHERE state IN ('publishing', 'shipped', 'undoing', 'undone'))`;
              const error =
                cause.reasons.find(
                  (reason) =>
                    reason._tag === "Fail" &&
                    isRepairError(reason.error) &&
                    reason.error.reason === "symlink-denied",
                ) ?? cause.reasons.find((reason) => reason._tag === "Fail");
              const reason =
                error?._tag === "Fail"
                  ? isRepairError(error.error)
                    ? error.error.reason
                    : Cause.isTimeoutError(error.error) ||
                        error.error._tag === "ProcessTimeoutError"
                      ? "timeout"
                      : `${phase}-failed`
                  : cause.reasons.some((reason) => reason._tag === "Die")
                    ? `${phase}-defect`
                    : "interrupted";
              const failure = yield* encodeJson({ stage: phase, cause: Cause.pretty(cause) });
              yield* sql`UPDATE ozi_replays SET state = 'failed', reason = ${reason}, evidence_json = json_set(COALESCE(evidence_json, '{}'), '$.failure', json(${failure})) WHERE id = ${id} AND state = 'running'`;
            }),
          )
          .pipe(Effect.andThen(publish)),
      ),
    );
  });

  const logMistake: Repair["Service"]["logMistake"] = Effect.fn("Repair.logMistake")(
    (input, caller) =>
      normalized(
        Effect.gen(function* () {
          const calling = yield* projection(caller.threadId);
          if (
            caller.origin === "agent" &&
            !calling.providerSessions.some(
              (session) => session.providerInstanceId === caller.providerInstanceId,
            )
          )
            return yield* fail("invalid-caller");
          const source = yield* eventById(input.sourceEventId);
          if (!source) return yield* fail("invalid-source-event");
          const sourceThreadId = source.event.threadId;
          const current =
            sourceThreadId === caller.threadId ? calling : yield* projection(sourceThreadId);
          const descendsFrom = Effect.fn("Repair.sourceAuthority")(function* (
            child: OrchestrationV2ThreadProjection,
            ancestor: string,
          ) {
            let parent: string | null = child.thread.id;
            const visited = new Set<string>();
            while (parent && !visited.has(parent)) {
              if (parent === ancestor) return true;
              visited.add(parent);
              const shell: OrchestrationV2ThreadShell | null = yield* threads.getThreadShell(
                ThreadId.make(parent),
              );
              parent = shell?.lineage.parentThreadId ?? null;
            }
            return false;
          });
          const checker =
            "visibility" in calling.thread && calling.thread.visibility === "internal";
          if (
            !(yield* descendsFrom(current, caller.threadId)) &&
            !(checker && (yield* descendsFrom(calling, sourceThreadId)))
          )
            return yield* fail("source-authority-denied");
          const history = yield* sourceEvents(sourceThreadId);
          const existing =
            yield* sql<Mistake>`SELECT * FROM ozi_mistakes WHERE source_event_id = ${input.sourceEventId} AND fingerprint = ${input.fingerprint}`;
          const preceding = history.filter(
            (value) =>
              value.sequence < source.sequence &&
              value.event.type === "message.updated" &&
              userAuthored(value.event.payload),
          );
          const boundaryEvent = input.beforeUserMessageId
            ? preceding.find(
                (value) =>
                  value.event.type === "message.updated" &&
                  value.event.payload.id === input.beforeUserMessageId,
              )
            : preceding.at(-1);
          const boundary =
            boundaryEvent?.event.type === "message.updated"
              ? boundaryEvent.event.payload.id
              : undefined;
          const referenced = input.correctionMessageId
            ? yield* messageById(input.correctionMessageId)
            : undefined;
          const correctionThread = referenced
            ? yield* threads.getThreadShell(referenced.event.threadId)
            : null;
          const corrected =
            referenced &&
            referenced.sequence > source.sequence &&
            referenced.event.type === "message.updated" &&
            userAuthored(referenced.event.payload) &&
            (referenced.event.threadId === sourceThreadId ||
              (referenced.event.threadId === OZI_MAIN_THREAD_ID &&
                (yield* descendsFrom(current, OZI_MAIN_THREAD_ID))) ||
              (current.thread.jobId != null && correctionThread?.jobId === current.thread.jobId))
              ? referenced
              : undefined;
          const prior = existing[0];
          if (prior && (prior.status !== "logged" || prior.trigger_event_id !== null || !corrected))
            return { id: prior.id, status: prior.status };
          const repeat =
            (yield* sql`SELECT id FROM ozi_mistakes WHERE fingerprint = ${input.fingerprint} LIMIT 1`)
              .length > 0;
          const id = prior?.id ?? (yield* ids.randomUUIDv4());
          const message = current.messages.find((message) => message.id === boundary);
          const attempt = current.attempts.find((attempt) => attempt.runId === message?.runId);
          const sourceRun = current.runs.find((run) => run.id === message?.runId);
          const providerThread =
            current.providerThreads.find((thread) => thread.id === attempt?.providerThreadId) ??
            null;
          const nativeTurn = current.providerTurns.find(
            (turn) =>
              turn.id === attempt?.providerTurnId || (attempt && turn.runAttemptId === attempt.id),
          )?.nativeTurnRef;
          const nativeTurnId = nativeTurn?.strength === "strong" ? nativeTurn.nativeId : null;
          const harness = yield* encodeHarness({
            providerThread,
            nativeTurnId,
            selection: sourceRun?.modelSelection ?? current.thread.modelSelection,
          });
          yield* (
            prior
              ? sql`UPDATE ozi_mistakes SET boundary = ${boundary ?? null}, harness = ${harness}, trigger_event_id = ${corrected!.event.id} WHERE id = ${id}`
              : sql`INSERT INTO ozi_mistakes (id, at, thread, boundary, fingerprint, what, why, harness, status, source_event_id, trigger_event_id) VALUES (${id}, ${DateTime.formatIso(yield* DateTime.now)}, ${sourceThreadId}, ${boundary ?? null}, ${input.fingerprint}, ${input.what}, ${input.why}, ${harness}, 'logged', ${input.sourceEventId}, ${corrected?.event.id ?? (repeat ? input.sourceEventId : null)})`
          ).pipe(
            Effect.andThen(publish),
            Effect.andThen(
              corrected || repeat ? Queue.offer(queue, id).pipe(Effect.asVoid) : Effect.void,
            ),
            Effect.uninterruptible,
          );
          return { id, status: "logged" as const };
        }),
      ).pipe(logPermit.withPermits(1)),
  );

  const changeProtectedRule: Repair["Service"]["changeProtectedRule"] = Effect.fn(
    "Repair.changeProtectedRule",
  )((input, caller) =>
    normalized(
      Effect.gen(function* () {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.path))
          return yield* fail("protected-path-denied");
        const event = (yield* messageById(input.correctionMessageId))?.event;
        let threadId: string | null = caller.threadId;
        let authorized = false;
        const visited = new Set<string>();
        while (threadId && !visited.has(threadId)) {
          visited.add(threadId);
          const current: OrchestrationV2ThreadProjection = yield* projection(threadId);
          if (
            event?.type === "message.updated" &&
            event.threadId === threadId &&
            userAuthored(event.payload) &&
            event.payload.text === `Change protected/${input.path} to:\n${input.content}`
          )
            authorized = true;
          threadId = current.thread.lineage.parentThreadId;
        }
        if (!authorized) return yield* fail("protected-authority-denied");
        const protectedRoot = path.join(yield* fs.realPath(config.dataRoot), "protected");
        if ((yield* fs.realPath(protectedRoot)) !== protectedRoot)
          return yield* fail("symlink-denied");
        const file = path.join(protectedRoot, input.path);
        if ((yield* fs.exists(file)) && (yield* fs.realPath(file)) !== file)
          return yield* fail("symlink-denied");
        const temporary = yield* fs.makeTempFile({ directory: protectedRoot, prefix: ".rule-" });
        yield* fs
          .writeFileString(temporary, input.content)
          .pipe(
            Effect.andThen(fs.rename(temporary, file)),
            Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          );
        return { changed: true as const };
      }),
    ).pipe(dataRootPermit.withPermits(1)),
  );

  yield* sql`UPDATE ozi_mistakes SET status = 'failed' WHERE id IN (SELECT mistake_id FROM ozi_replays WHERE state = 'running') AND id NOT IN (SELECT id FROM ozi_fixes WHERE state IN ('publishing', 'shipped', 'undoing', 'undone'))`;
  yield* sql`UPDATE ozi_replays SET state = 'failed', reason = 'interrupted', evidence_json = json_set(COALESCE(evidence_json, '{}'), '$.failure', json(${yield* encodeJson({ stage: "recovery", cause: "Server stopped before replay completed." })})) WHERE state = 'running'`;
  for (const fix of yield* publisher.fixes()) yield* blocker(fix);
  for (const row of yield* sql<Mistake>`SELECT * FROM ozi_mistakes WHERE status = 'logged' AND trigger_event_id IS NOT NULL`)
    yield* Queue.offer(queue, row.id);
  yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach((id) =>
      run(id).pipe(Effect.catch((cause) => Effect.logError("Repair failed", { cause }))),
    ),
    Effect.forkScoped,
  );
  yield* events.streamApplicationEvents().pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (!("event" in event)) return;
        if (event.event.type === "turn-item.updated" && event.event.payload.type === "error") {
          const item = event.event.payload;
          if (RepairTasks.isRepairThread(item.threadId)) return;
          const current = yield* projection(item.threadId);
          const first = (yield* sourceEvents(item.threadId)).find(
            (value) =>
              value.event.type === "turn-item.updated" &&
              value.event.payload.type === "error" &&
              value.event.payload.id === item.id,
          );
          yield* logMistake(
            {
              sourceEventId: first?.event.id ?? event.event.id,
              fingerprint: `runtime.${item.failure.class}.${item.failure.code ?? "unknown"}`,
              what: item.failure.message,
              why: "unknown",
            },
            {
              threadId: item.threadId,
              providerInstanceId: current.thread.modelSelection.instanceId,
              origin: "runtime",
            },
          );
          return;
        }
      }).pipe(Effect.catch((cause) => Effect.logError("Repair event failed", { cause }))),
    ),
    Effect.forkScoped,
  );
  return Repair.of({
    logMistake,
    changeProtectedRule,
    mistakes,
    replays,
    fixes: publisher.fixes,
    undo,
    subscribe: (entity, id) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* publisher.subscribeChanges();
          const read: Effect.Effect<ReadonlyArray<Mistake | Replay | Fix>, RepairError> = entity ===
          "mistake"
            ? mistakes(id)
            : entity === "fix"
              ? normalized(sql<Fix>`SELECT * FROM ozi_fixes WHERE id = ${id}`)
              : normalized(sql<Replay>`SELECT * FROM ozi_replays WHERE id = ${id}`);
          return Stream.concat(
            Stream.fromEffect(read),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read)),
          ).pipe(Stream.map((rows) => rows[0] ?? null));
        }),
      ),
    events: Effect.fn("Repair.events")((threadId: string) => normalized(sourceEvents(threadId))),
  });
});

export const layer = Layer.effect(Repair, make).pipe(
  Layer.provide(RepairSandbox.layer),
  Layer.provide(Publisher.layer),
);
