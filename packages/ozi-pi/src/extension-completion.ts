import * as NodeCrypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Type } from "typebox";
import { checkClaim } from "./Completion.ts";
import { settle, type Verdict } from "./CompletionPolicy.ts";
import * as Evidence from "./Evidence.ts";
import { statePath, textOf } from "./repair.ts";
import { openStore } from "./store.ts";

const nameOf = (name: string) => name.split(/__|\./).at(-1);
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = Type.String({ minLength: 1 });
const ticket = Type.Object({
  group: Type.Literal("Review"),
  title: text,
  need: text,
  summary: text,
  choices: Type.Array(Type.Object({ label: text, detail: text }), { maxItems: 4 }),
  markdown: Type.String(),
  attachments: Type.Array(Type.Unknown()),
  htmlPages: Type.Array(Type.Unknown()),
});
export type Check = {
  id: string;
  session: string;
  request: string;
  workerId: string;
  at: string;
  state: ReturnType<typeof settle>["state"] | "failed";
  unsuccessfulRounds: number;
  verdict: Verdict | null;
  verified: readonly string[];
  evidence: string[];
  error: string | null;
  action: unknown;
  fingerprint: string;
};
export function checks(db: ReturnType<typeof openStore>): Check[] {
  return db
    .prepare("SELECT record FROM ozi_checks ORDER BY rowid")
    .all()
    .map((row) => JSON.parse(String(row.record)));
}

export function installCompletion(pi: ExtensionAPI, dataRoot: () => string) {
  const permits = new Map<string, string>();
  pi.on("tool_call", (event, ctx) => {
    if (
      process.env.OZI_INBOX_FORK === "1" &&
      !ctx.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.content.some(
              (part) =>
                part.type === "toolCall" &&
                /^(?:completion_check|delegate_task|task_(?:result|status)|(?:ozi|t3)_thread_(?:read|send))$/.test(
                  nameOf(part.name) ?? "",
                ),
            ),
        )
    )
      return;
    const name = nameOf(event.toolName);
    const content =
      name === "ticket_update" ? (event.input as Record<string, unknown>).changes : event.input;
    if (
      (name !== "ticket_create" && name !== "ticket_update") ||
      !content ||
      typeof content !== "object" ||
      ("group" in content && content.group !== "Review") ||
      (!("group" in content) && name !== "ticket_update")
    )
      return;
    if (event.parentToolCallId && permits.get(event.parentToolCallId) === hash(event.input)) return;
    return {
      block: true,
      reason:
        "Worker Reviews require main to use completion_check with the worker ID, evidence files and proposed ticket. Use an existing checked ticket or file Read for an unchecked claim. For non-Review updates include the ticket group explicitly.",
    };
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.appendSystemPrompt = [
      event.systemPromptOptions.appendSystemPrompt,
      "Before reporting a worker's finished job, use completion_check with its workerId, evidence files and a proposed Review ticket. First inspect diffs, real test output and exit status, files and PR state using the GUI's tools. completion_check verifies the claim and files through ticket_create/ticket_update, sends the worker back for missing work, or files a Decide/Do/Read blocker or failure. A worker claim alone never passes. Use ticket_* directly for questions, human actions and failures. Skip tickets for small talk.",
    ]
      .filter(Boolean)
      .join("\n");
  });
  pi.registerTool({
    name: "completion_check",
    label: "Completion check",
    description:
      "Check a finished worker against real evidence before Review. Supply workspace evidence files (including saved test output when relevant) and a proposed Review ticket. Reads the worker through the GUI, checks on an isolated native Pi fork, then files a verified Review, sends gaps back, or files a blocker/failure. Never treat a worker claim as proof. Optional ticketId updates an existing ticket.",
    parameters: Type.Object({
      workerId: text,
      files: Type.Array(text, { maxItems: 32 }),
      ticket,
      ticketId: Type.Optional(text),
    }),
    async execute(toolCallId, args, signal, _update, ctx) {
      const db = openStore(statePath(dataRoot()));
      const session = ctx.sessionManager.getSessionId();
      const branch = ctx.sessionManager.getBranch();
      const request = branch.findLast(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )?.id;
      if (!request) {
        db.close();
        throw new Error("missing-request");
      }
      const before = checks(db).findLast(
        (row) =>
          row.session === session && row.request === request && row.workerId === args.workerId,
      );
      const record: Check = {
        id: NodeCrypto.randomUUID(),
        session,
        request,
        workerId: args.workerId,
        at: DateTime.formatIso(Effect.runSync(DateTime.now)),
        state: "checking",
        unsuccessfulRounds: before?.unsuccessfulRounds ?? 0,
        verdict: null,
        verified: [],
        evidence: [],
        error: null,
        action: null,
        fingerprint: "",
      };
      const save = () =>
        db
          .prepare(
            "INSERT INTO ozi_checks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
          )
          .run(record.id, JSON.stringify(record));
      const call = async (names: string[], input: Record<string, unknown>) => {
        const tool = ctx.tools.find((tool) => names.includes(nameOf(tool.name) ?? ""));
        if (!tool) throw new Error(`missing-gui-tool:${names[0]}`);
        const result = await ctx.executeTool(tool.name, input, signal ? { signal } : {});
        if (result.isError) throw new Error(`gui-tool-failed:${names[0]}`);
        const value =
          result.result.structuredContent ??
          result.result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        let decoded = typeof value === "string" ? JSON.parse(value) : value;
        if (
          decoded &&
          typeof decoded === "object" &&
          "content" in decoded &&
          Array.isArray(decoded.content)
        ) {
          decoded =
            "structuredContent" in decoded
              ? decoded.structuredContent
              : JSON.parse(
                  decoded.content
                    .filter((part: { type: string }) => part.type === "text")
                    .map((part: { text: string }) => part.text)
                    .join("\n"),
                );
        }
        if (
          decoded &&
          typeof decoded === "object" &&
          ("error" in decoded || decoded.isError === true)
        )
          throw new Error(`gui-tool-failed:${names[0]}`);
        return decoded;
      };
      const worker = async () => {
        const value = await call(["ozi_thread_read", "t3_thread_read"], {
          threadId: args.workerId,
          view: "activity",
          limit: 100,
          maxCharsPerItem: 50000,
        });
        if (
          !value ||
          typeof value !== "object" ||
          !("thread" in value) ||
          !("items" in value) ||
          !("recentRuns" in value)
        )
          throw new Error("invalid-worker-history");
        const thread = value.thread as {
          threadId: string;
          activeRunId: string | null;
          pendingRequestCount: number;
          latestRunId: string | null;
        };
        const runs = value.recentRuns as { runId: string; status: string }[];
        if (
          thread.threadId !== args.workerId ||
          thread.activeRunId ||
          thread.pendingRequestCount ||
          !runs.some((run) => run.runId === thread.latestRunId && run.status === "completed")
        )
          throw new Error("worker-not-completed");
        if (
          ("hasMore" in value && value.hasMore) ||
          (value.items as { textTruncated?: boolean }[]).some((item) => item.textTruncated)
        )
          throw new Error("incomplete-worker-evidence");
        return value;
      };
      try {
        save();
        let fingerprint = "";
        let attention: "Decide" | "Do" = "Decide";
        try {
          const source = await worker();
          const files = await Effect.runPromise(
            Effect.forEach(args.files, (file) => Evidence.read(ctx.cwd, file)).pipe(
              Effect.provide(NodeServices.layer),
            ),
          );
          record.evidence = files.map((file) => file.evidence);
          fingerprint = hash({
            source,
            evidence: record.evidence,
            ticket: args.ticket,
            ticketId: args.ticketId,
          });
          record.fingerprint = fingerprint;
          if (before?.state === "checked" && before.action && before.fingerprint === fingerprint) {
            db.prepare("DELETE FROM ozi_checks WHERE id=?").run(record.id);
            Object.assign(record, before);
            return { content: [{ type: "text", text: JSON.stringify(record) }], details: record };
          }
          const result = await checkClaim(
            ctx,
            statePath(dataRoot()),
            record.id,
            toolCallId,
            {
              worker: source,
              files,
              proposedReview: args.ticket,
              request: branch
                .filter((entry) => entry.type === "message" && entry.message.role === "user")
                .map(textOf),
            },
            signal,
          );
          const unchanged =
            hash(await worker()) === hash(source) &&
            (await Effect.runPromise(
              Effect.forEach(record.evidence, (item) => Evidence.verify(ctx.cwd, item)).pipe(
                Effect.map((values) => values.every(Boolean)),
                Effect.provide(NodeServices.layer),
              ),
            ));
          const currentRequest = ctx.sessionManager
            .getBranch()
            .findLast((entry) => entry.type === "message" && entry.message.role === "user")?.id;
          if (!unchanged || currentRequest !== request || signal?.aborted) {
            record.state = "superseded";
            record.error = "Evidence or request changed during verification.";
            return { content: [{ type: "text", text: JSON.stringify(record) }], details: record };
          }
          attention = result.attention ?? "Decide";
          record.verdict = result.verdict;
          record.verified = result.verified;
        } catch (error) {
          if (signal?.aborted) {
            record.state = "superseded";
            record.error = "Check cancelled.";
            return { content: [{ type: "text", text: JSON.stringify(record) }], details: record };
          }
          record.error =
            error instanceof Error && /^[a-z-]+$/.test(error.message)
              ? error.message
              : "Completion could not be verified. Inspect worker history, evidence files and checker availability.";
        }
        const progress = Boolean(
          fingerprint &&
          before &&
          before.evidence.length &&
          record.evidence.some((entry) => !before.evidence.includes(entry)),
        );
        Object.assign(record, settle(record.verdict, record.unsuccessfulRounds, progress));
        if (record.error) record.state = "failed";
        const verdict = record.verdict;
        if (verdict?.verdict === "continue" && record.state !== "blocked") {
          record.action = await call(["ozi_thread_send", "t3_thread_send"], {
            threadId: args.workerId,
            message: `Completion check found missing work: ${verdict.missing}\nVerified evidence: ${record.evidence.join(", ")}\nFinish the original request and return real evidence.`,
            mode: "auto",
          });
        } else if (
          verdict?.verdict === "done" ||
          verdict?.verdict === "needs_user" ||
          record.state === "blocked" ||
          record.error
        ) {
          const group =
            verdict?.verdict === "done"
              ? "Review"
              : verdict?.verdict === "needs_user"
                ? attention
                : "Read";
          const reason =
            verdict?.verdict === "needs_user"
              ? verdict.reason
              : verdict?.verdict === "continue"
                ? verdict.missing
                : (record.error ?? "No verified progress after three rounds.");
          const content =
            group === "Review"
              ? {
                  ...args.ticket,
                  markdown: `${args.ticket.markdown}\n\nVerified by completion check ${record.id}:\n${record.verified.map((fact) => `- ${fact}`).join("\n")}\n\nEvidence: ${record.evidence.join(", ")}`,
                }
              : {
                  group,
                  title: `Completion ${group === "Read" ? "failed" : "blocked"}: ${args.ticket.title}`,
                  need: group === "Read" ? "Review the failure." : reason,
                  summary: reason,
                  markdown: `Worker: ${args.workerId}\n\n${reason}\n\nCheck: ${record.id}`,
                  choices: [],
                  attachments: [],
                  htmlPages: [],
                };
          const input = args.ticketId ? { id: args.ticketId, changes: content } : content;
          permits.set(toolCallId, hash(input));
          try {
            record.action = await call([args.ticketId ? "ticket_update" : "ticket_create"], input);
          } finally {
            permits.delete(toolCallId);
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(record) }], details: record };
      } catch {
        record.state = signal?.aborted ? "superseded" : "failed";
        record.error = "GUI delivery failed; no completion action was confirmed.";
        return { content: [{ type: "text", text: JSON.stringify(record) }], details: record };
      } finally {
        save();
        db.close();
      }
    },
  });
}
