import { settle } from "@ozi/pi/CompletionPolicy";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import {
  CommandId,
  EventId,
  MessageId,
  OziCheck,
  OziCheckVerdict,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type RunId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import * as Evidence from "./Evidence.ts";
import { verdictText } from "./verdictText.ts";

const decodeVerdict = Schema.decodeUnknownEffect(Schema.fromJsonString(OziCheckVerdict));

type Phase = "prepare" | "resolve" | "continue";
export const storageFailure = (cause: unknown): boolean =>
  cause instanceof Error &&
  (/Sql|EventSink|ProjectionStore|CommandReceiptStore|EffectOutbox/.test(cause.name) ||
    storageFailure(cause.cause));
const failureText = (cause: unknown): string =>
  cause instanceof Error
    ? `${cause.message}${cause.cause === undefined ? "" : `: ${failureText(cause.cause)}`}`
    : String(cause);
const command = (id: string) => CommandId.make(`command:completion:${id}`);
export const checkEffect = (
  threadId: ThreadId,
  runId: RunId,
  phase: Phase,
  round = 0,
  deadline?: DateTime.Utc,
): PendingOrchestrationEffectV2 => ({
  id: `effect:check:${runId}:${phase}:${round}:${deadline ? "deadline" : "now"}`,
  commandId: command(`${runId}:${phase}:${round}`),
  threadId: ThreadId.make(`checker:${runId}:${phase}:${round}:${deadline ? "deadline" : "now"}`),
  request: { type: "completion.check", threadId, runId, phase, round },
  ...(deadline ? { availableAt: deadline } : {}),
});

const isRequest = (message: OrchestrationV2ConversationMessage) =>
  message.role === "user" &&
  (message.createdBy !== "system" || message.scheduledTaskId !== undefined) &&
  message.notification === undefined &&
  message.delegatedCompletion === undefined;

const orderedMessages = Effect.fn("Completion.orderedMessages")(function* (
  threadId: ThreadId,
  store: EventStore.EventStoreV2["Service"],
) {
  const events = yield* store
    .read({ threadId, eventType: "message.updated" })
    .pipe(Stream.runCollect);
  const messages = new Map<
    MessageId,
    { eventId: EventId; message: OrchestrationV2ConversationMessage }
  >();
  for (const { event } of events) {
    if (event.type !== "message.updated") continue;
    messages.set(event.payload.id, {
      eventId: messages.get(event.payload.id)?.eventId ?? event.id,
      message: event.payload,
    });
  }
  return [...messages.values()];
});

export const capture = Effect.fn("Completion.capture")(function* (input: {
  run: OrchestrationV2Run;
  projections: ProjectionStore.ProjectionStoreV2["Service"];
  now: DateTime.Utc;
  eventId?: EventId;
}) {
  if (input.run.promptDisposition === "handled") return;
  const projection = yield* input.projections.getThreadRecords(input.run.threadId, [
    "runs",
    "messages",
    "turnItems",
  ]);
  if (projection.thread.role === "checker") {
    const source = projection.thread.checkFor;
    return source
      ? {
          check: undefined,
          effect: checkEffect(source.threadId, source.runId, "resolve", source.round),
        }
      : undefined;
  }
  const store = yield* EventStore.EventStoreV2;
  const messages = yield* orderedMessages(input.run.threadId, store);
  const sourceIndex = messages.findIndex(({ message }) => message.id === input.run.userMessageId);
  const request = messages.findLast(
    ({ message }, index) =>
      isRequest(message) && (message.runId === input.run.id || index <= sourceIndex),
  );
  const requestEventId = request?.eventId ?? EventId.make(input.run.userMessageId);
  const previous = projection.runs.findLast(
    (run) => run.completionCheck?.requestEventId === requestEventId,
  )?.completionCheck;
  const report = projection.turnItems.findLast(
    (item) => item.runId === input.run.id && item.type === "assistant_message",
  );
  const text = projection.messages
    .filter((message) => message.runId === input.run.id && message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
  const now = DateTime.formatIso(input.now);
  const check: OziCheck = {
    id: EventId.make(`check:${input.run.id}`),
    eventId: input.eventId ?? EventId.make(`check:${input.run.id}`),
    threadId: input.run.threadId,
    runId: input.run.id,
    requestEventId,
    reportItemId: report?.id ?? null,
    report: text,
    state: "checking",
    sourceCaptured: false,
    unsuccessfulRounds: previous?.unsuccessfulRounds ?? 0,
    evidence: previous?.evidence ?? [],
    rounds: [],
    createdAt: now,
    updatedAt: now,
  };
  return { check, effect: checkEffect(input.run.threadId, input.run.id, "prepare") };
});

export class CompletionError extends Schema.TaggedError<CompletionError>()("CompletionError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Completion extends Context.Service<
  Completion,
  {
    readonly execute: (
      threadId: ThreadId,
      runId: RunId,
      phase: Phase,
      round: number,
    ) => Effect.Effect<void, CompletionError>;
    readonly recover: Effect.Effect<void, CompletionError>;
    readonly list: (threadId?: ThreadId) => Effect.Effect<ReadonlyArray<OziCheck>, CompletionError>;
    readonly claim: (input: {
      threadId: ThreadId;
      runId: RunId;
      requestEventId: EventId;
      reportItemId: TurnItemId | null;
    }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, CompletionError>;
  }
>()("ozi/ozi/Completion") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* EventStore.EventStoreV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const dispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const read = (threadId: ThreadId) =>
    projections.getThreadRecords(threadId, [
      "runs",
      "messages",
      "runtimeRequests",
      "providerThreads",
      "turnItems",
    ]);
  const save = (check: OziCheck, effects: ReadonlyArray<PendingOrchestrationEffectV2> = []) => {
    const eventId = EventId.make(
      `${check.id}:${check.updatedAt}:${check.state}:${check.rounds.length}:${check.rounds.at(-1)?.completedAt ?? "pending"}`,
    );
    return sink.writeWithEffects({
      events: [
        {
          id: eventId,
          type: "completion.updated",
          threadId: check.threadId,
          runId: check.runId,
          occurredAt: DateTime.makeUnsafe(check.updatedAt),
          payload: { ...check, eventId },
        },
      ],
      effects,
    });
  };
  const obsolete = Effect.fn("Completion.obsolete")(function* (
    projection: Effect.Success<ReturnType<typeof read>>,
    check: OziCheck,
  ) {
    const run = projection.runs.find((run) => run.id === check.runId);
    if (run?.status !== "completed") return true;
    const messages = yield* orderedMessages(check.threadId, store);
    const sourceIndex = messages.findIndex(({ message }) => message.id === run.userMessageId);
    return messages.some(
      ({ message }, index) => isRequest(message) && message.runId !== run.id && index > sourceIndex,
    );
  });
  const finish = Effect.fn("Completion.finish")(function* (
    check: OziCheck,
    verdict: OziCheckVerdict | null,
    error: string | null,
    tokens: number | null,
  ) {
    yield* dispatch.withLock(
      check.threadId,
      Effect.gen(function* () {
        const current = yield* read(check.threadId);
        const latest = current.runs.find((run) => run.id === check.runId)?.completionCheck;
        if (
          !latest ||
          !["checking", "superseded"].includes(latest.state) ||
          latest.rounds.length !== check.rounds.length ||
          latest.rounds.at(-1)?.completedAt !== null
        )
          return;
        check = latest;
        const now = DateTime.formatIso(yield* DateTime.now);
        const superseded = check.state === "superseded" || (yield* obsolete(current, check));
        const root = (yield* runtimePolicy.resolve({
          thread: current.thread,
          modelSelection: current.thread.modelSelection,
        })).cwd;
        const verified =
          verdict?.verdict === "continue" && root
            ? yield* Effect.filter(verdict.evidence, (evidence) =>
                (evidence.startsWith("action:")
                  ? Evidence.verifyAction(current.turnItems, evidence)
                  : Evidence.verify(root, evidence)
                ).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(Crypto.Crypto, crypto),
                ),
              )
            : [];
        const evidenceKey = (evidence: string) =>
          evidence.startsWith("action:") ? evidence.slice(evidence.lastIndexOf(":")) : evidence;
        const progress = verified.some(
          (evidence) =>
            !check.evidence.some((previous) => evidenceKey(previous) === evidenceKey(evidence)),
        );
        const { state, unsuccessfulRounds } = settle(
          verdict,
          check.unsuccessfulRounds,
          progress,
          superseded,
        );
        const misses = verdict?.verdict === "continue" ? [verdict.missing] : error ? [error] : [];
        yield* save(
          {
            ...check,
            state,
            unsuccessfulRounds,
            updatedAt: now,
            evidence: [...new Set([...check.evidence, ...verified])],
            rounds: check.rounds.map((entry, index) =>
              index === check.rounds.length - 1
                ? {
                    ...entry,
                    verdict,
                    error,
                    misses,
                    evidence: verified,
                    tokens,
                    completedAt: now,
                  }
                : entry,
            ),
          },
          state === "continued"
            ? [checkEffect(check.threadId, check.runId, "continue", check.rounds.length)]
            : state === "checking"
              ? [checkEffect(check.threadId, check.runId, "prepare", check.rounds.length)]
              : [],
        );
      }),
    );
  });
  const execute = Effect.fn("Completion.execute")(
    function* (threadId: ThreadId, runId: RunId, phase: Phase, expectedRound: number) {
      const projection = yield* read(threadId);
      let check = projection.runs.find((run) => run.id === runId)?.completionCheck;
      if (
        !check ||
        (phase === "continue"
          ? check.state !== "continued"
          : check.state !== "checking" && !(phase === "resolve" && check.state === "superseded"))
      )
        return;
      if (check.state !== "superseded" && (yield* obsolete(projection, check))) {
        yield* save({
          ...check,
          state: "superseded",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        return;
      }
      if (phase === "continue") {
        yield* orchestrator.dispatch({
          type: "completion.resume",
          commandId: command(`${check.id}:continue`),
          threadId,
          checkId: check.id,
        });
        return;
      }
      if (phase === "prepare") {
        let round = check.rounds.at(-1);
        if (expectedRound !== check.rounds.length - (round?.completedAt === null ? 1 : 0)) return;
        if (!round || round.completedAt !== null) {
          const startedAt = DateTime.formatIso(yield* DateTime.now);
          round = {
            round: check.rounds.length + 1,
            checkerThreadId: ThreadId.make(`${check.id}:round:${check.rounds.length + 1}`),
            verdict: null,
            error: null,
            misses: [],
            evidence: [],
            tokens: 0,
            startedAt,
            completedAt: null,
          };
          check = { ...check, rounds: [...check.rounds, round], updatedAt: startedAt };
          yield* save(check, [
            checkEffect(
              threadId,
              runId,
              "resolve",
              round.round,
              DateTime.makeUnsafe(Date.parse(startedAt) + 120000),
            ),
          ]);
        }
        const source = projection.providerThreads.find(
          (thread) =>
            thread.id === projection.runs.find((run) => run.id === runId)?.providerThreadId,
        );
        const prepared = yield* Effect.exit(
          Effect.gen(function* () {
            if (source?.nativeThreadRef?.strength !== "strong")
              return yield* new CompletionError({
                operation: "fork",
                cause: "Completion requires intact native history.",
              });
            yield* orchestrator.dispatch({
              type: "completion.fork",
              commandId: command(`${round.checkerThreadId}:fork`),
              sourceThreadId: threadId,
              targetThreadId: round.checkerThreadId,
              sourcePoint: { type: "run", runId },
              createdBy: "system",
              creationSource: "server",
            });
            let origin = "";
            if (projection.thread.visibility === "quiet" && projection.thread.jobId) {
              const lead =
                projection.thread.id === projection.thread.jobId
                  ? projection
                  : yield* projections.getThreadRecords(projection.thread.jobId, []);
              const parentId = lead.thread.lineage.parentThreadId;
              if (parentId) {
                const parent = yield* projections.getThreadRecords(parentId, ["runs", "subagents"]);
                const task = parent.subagents.findLast(
                  (task) => task.childThreadId === lead.thread.id,
                );
                const run = parent.runs.find((run) => run.id === task?.runId);
                const messages = yield* orderedMessages(parentId, store);
                const request = messages.find(
                  ({ eventId, message }) =>
                    eventId === run?.completionCheck?.requestEventId ||
                    message.id === run?.userMessageId,
                )?.message;
                if (request?.scheduledTaskId !== undefined)
                  origin = `\nOriginating request: ${request.text}`;
              }
            }
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: command(`${round.checkerThreadId}:start`),
              threadId: round.checkerThreadId,
              messageId: MessageId.make(`${round.checkerThreadId}:request`),
              text: `OZI COMPLETION CHECK round ${round.round}\nIs the current request fully done? Did the claimant hand the user anything it could do itself? Main owes coordination and reporting; background jobs may still run. Inspect inherited history and evidence. Never act, delegate or continue the work. Return only JSON: {"verdict":"done","useful":boolean}, {"verdict":"continue","missing":"specific missing obligations","evidence":["path:sha256 or action receipt from completion_evidence"],"useful":boolean}, or {"verdict":"needs_user","reason":"missing human decision or action","useful":boolean}. For quiet jobs, useful:true only when the originating request's reporting condition is met or the user is needed. Extra tool calls or rewording are not progress.${origin}\nClaim: ${check!.report}`,
              attachments: [],
              createdBy: "system",
              creationSource: "server",
              dispatchMode: { type: "start_immediately" },
            });
          }),
        );
        if (prepared._tag === "Failure") {
          if (Cause.hasInterruptsOnly(prepared.cause))
            return yield* Effect.failCause(prepared.cause);
          const failure = Cause.squash(prepared.cause);
          if (storageFailure(failure))
            return yield* new CompletionError({ operation: "prepare", cause: failure });
          yield* finish(check, null, failureText(failure), 0);
        }
        return;
      }
      const round = check.rounds.at(-1);
      if (!round || round.round !== expectedRound || round.completedAt !== null) return;
      const checker = yield* projections
        .getThreadRecords(round.checkerThreadId, [
          "runs",
          "messages",
          "providerTurns",
          "contextTransfers",
        ])
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined) }),
          Effect.map(Option.fromUndefinedOr),
        );
      if (
        Option.isSome(checker) &&
        ["preparing", "starting", "running"].includes(checker.value.runs.at(-1)?.status ?? "")
      )
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: command(`${round.checkerThreadId}:deadline`),
          threadId: round.checkerThreadId,
        });
      const usage = Option.isSome(checker)
        ? checker.value.providerTurns.flatMap((turn) =>
            turn.turnTokenUsage && turn.turnTokenUsage.usageStatus !== "unavailable"
              ? [turn.turnTokenUsage]
              : [],
          )
        : [];
      let tokens =
        usage.length > 0
          ? usage.reduce((sum, turn) => sum + (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0), 0)
          : null;
      if (tokens === null && Option.isSome(checker)) {
        const baseline = checker.value.contextTransfers.find(
          (transfer) => transfer.resolution?.strategy === "native_fork",
        )?.sourceTokenUsage;
        const total = checker.value.providerTurns.at(-1)?.tokenUsage;
        if (
          baseline?.inputTokens !== undefined &&
          baseline.outputTokens !== undefined &&
          total?.inputTokens !== undefined &&
          total.outputTokens !== undefined
        )
          tokens = Math.max(
            0,
            total.inputTokens + total.outputTokens - baseline.inputTokens - baseline.outputTokens,
          );
      }
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          if (
            Option.isNone(checker) ||
            checker.value.runs.at(-1)?.status !== "completed" ||
            !checker.value.contextTransfers.some(
              (transfer) => transfer.resolution?.strategy === "native_fork",
            )
          )
            return yield* new CompletionError({
              operation: "checker",
              cause: "Checker failed, missed its deadline, or lost native history.",
            });
          const text =
            checker.value.messages.findLast((message) => message.role === "assistant")?.text ?? "";
          return yield* decodeVerdict(verdictText(text));
        }),
      );
      yield* finish(
        check,
        outcome._tag === "Success" ? outcome.success : null,
        outcome._tag === "Failure" ? failureText(outcome.failure) : null,
        tokens,
      );
    },
    Effect.mapError((cause) => new CompletionError({ operation: "execute", cause })),
  );
  const list = Effect.fn("Completion.list")(
    function* (threadId?: ThreadId) {
      const ids = threadId
        ? [threadId]
        : (yield* projections.getShellSnapshot()).threads.map((thread) => thread.id);
      const records = yield* Effect.forEach(ids, (id) =>
        projections.getThreadRecords(id, ["runs"]),
      );
      return records.flatMap((projection) =>
        projection.runs.flatMap((run) => (run.completionCheck ? [run.completionCheck] : [])),
      );
    },
    Effect.mapError((cause) => new CompletionError({ operation: "list", cause })),
  );
  const claim = Effect.fn("Completion.claim")(
    function* (input: {
      threadId: ThreadId;
      runId: RunId;
      requestEventId: EventId;
      reportItemId: TurnItemId | null;
    }) {
      const commandId = command(`${input.runId}:claim`);
      const previous = yield* receipts.getByCommandId(commandId);
      if (Option.isSome(previous)) return previous.value;
      const source = yield* read(input.threadId);
      const run = source.runs.find((run) => run.id === input.runId);
      if (!run || run.status !== "completed" || source.thread.role === "checker")
        return yield* new CompletionError({
          operation: "claim",
          cause: "A claim requires settled, unstopped work.",
        });
      const now = yield* DateTime.now;
      const candidate = run.completionCheck
        ? undefined
        : yield* capture({ run, projections, now }).pipe(
            Effect.provideService(EventStore.EventStoreV2, store),
          );
      const result = yield* sink.commitCommand({
        commandId,
        threadId: input.threadId,
        commandType: "ozi.completion.claim",
        acceptedAt: now,
        events: candidate?.check
          ? [
              {
                id: candidate.check.id,
                type: "completion.updated",
                threadId: input.threadId,
                runId: input.runId,
                occurredAt: now,
                payload: {
                  ...candidate.check,
                  requestEventId: input.requestEventId,
                  reportItemId: input.reportItemId,
                },
              },
            ]
          : [],
        effects: candidate ? [candidate.effect] : [],
      });
      return result.receipt;
    },
    Effect.mapError((cause) => new CompletionError({ operation: "claim", cause })),
  );
  const recover = Effect.gen(function* () {
    const pending = (yield* list()).filter(
      (check) => check.state === "checking" || check.state === "continued",
    );
    for (const check of pending) {
      const round = check.rounds.at(-1);
      yield* sink.writeWithEffects({
        events: [],
        effects: [
          checkEffect(
            check.threadId,
            check.runId,
            check.state === "continued"
              ? "continue"
              : round?.completedAt === null
                ? "resolve"
                : "prepare",
            round?.round ?? 0,
          ),
        ],
      });
    }
  }).pipe(Effect.mapError((cause) => new CompletionError({ operation: "recover", cause })));
  return Completion.of({ execute, list, claim, recover });
});

export const layer = Layer.effect(Completion, make);
