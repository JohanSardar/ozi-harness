import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openStore } from "./store.ts";
import {
  acquireRoot,
  locked,
  logMistake,
  statePath,
  syncSession,
  textOf,
  type SessionSnapshot,
  withEngine,
} from "./repair.ts";

export function installRepair(pi: ExtensionAPI, dataRoot: () => string) {
  const state = () => statePath(dataRoot());
  const store = () => openStore(state());
  let watcher: NodeFS.FSWatcher | undefined;
  let blockerDb: ReturnType<typeof openStore> | undefined;
  const notified = new Set<string>();
  const reads = new Map<string, () => Promise<void>>();
  let trustedText: string | undefined;
  const snapshot = (ctx: ExtensionContext, active: boolean) => {
    const entries = ctx.sessionManager.getBranch();
    const header = ctx.sessionManager.getHeader();
    if (!header) throw new Error("missing-native-history");
    const user = entries.findLast(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const value: SessionSnapshot = {
      header,
      entries,
      model: `${ctx.model?.provider}/${ctx.model?.id}`,
      thinking: pi.getThinkingLevel(),
      tools: pi.getAllTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    };
    const db = store();
    try {
      syncSession(
        db,
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getSessionFile(),
        active,
        value,
        user && trustedText === textOf(user) ? user.id : undefined,
      );
    } finally {
      db.close();
    }
    if (user && trustedText === textOf(user)) trustedText = undefined;
    return value;
  };
  const worker = () => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./cli.mjs", import.meta.url)),
        "worker",
        "--data-root",
        dataRoot(),
        "--json",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
  };
  const toolResult = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  });
  pi.registerTool({
    name: "repair_context",
    label: "Repair context",
    description:
      "Read native message IDs before logging a mistake. User messages alone authorize corrections.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const value = snapshot(ctx, !ctx.isIdle());
      return toolResult(
        value.entries
          .filter((entry) => entry.type === "message")
          .map((entry) => ({
            id: entry.id,
            role: entry.type === "message" ? entry.message.role : "",
            text: textOf(entry),
          })),
      );
    },
  });
  const text = Type.String({ minLength: 1, maxLength: 4096 });
  pi.registerTool({
    name: "log_mistake",
    label: "Log mistake",
    description:
      "Log what went wrong and why. Use repair_context IDs. Repair runs only for a later user correctionMessageId or a repeated fingerprint. Logging acknowledges storage only.",
    parameters: Type.Object({
      sourceEventId: text,
      correctionMessageId: Type.Optional(text),
      beforeUserMessageId: Type.Optional(text),
      fingerprint: text,
      what: text,
      why: text,
    }),
    async execute(_id, args, _signal, _update, ctx) {
      snapshot(ctx, true);
      const db = store();
      try {
        return toolResult(logMistake(db, ctx.sessionManager.getSessionId(), args));
      } finally {
        db.close();
      }
    },
  });
  pi.registerTool({
    name: "change_protected_rule",
    label: "Change protected rule",
    description:
      "Change protected/<path> only when correctionMessageId is the user's exact instruction: Change protected/<path> to: followed by a newline and content.",
    parameters: Type.Object({
      correctionMessageId: text,
      path: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" }),
      content: Type.String(),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const value = snapshot(ctx, true);
      const db = store();
      try {
        const entry = value.entries.find((entry) => entry.id === args.correctionMessageId);
        if (
          !entry ||
          !db
            .prepare("SELECT 1 FROM ozi_user_messages WHERE session=? AND id=?")
            .get(ctx.sessionManager.getSessionId(), entry.id) ||
          textOf(entry) !== `Change protected/${args.path} to:\n${args.content}`
        )
          throw new Error("protected-authority-denied");
        await locked(dataRoot(), async () => {
          const dir = NodePath.join(dataRoot(), "protected");
          if (NodeFS.realpathSync(dir) !== dir || NodeFS.lstatSync(dir).isSymbolicLink())
            throw new Error("symlink-denied");
          const file = NodePath.join(dir, args.path);
          try {
            if (!NodeFS.lstatSync(file).isFile()) throw new Error("symlink-denied");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const temporary = NodePath.join(dir, `.rule-${process.pid}`);
          NodeFS.writeFileSync(temporary, args.content, { flag: "wx" });
          NodeFS.renameSync(temporary, file);
        });
        return toolResult({ changed: true });
      } finally {
        db.close();
      }
    },
  });
  pi.on("input", (event) => {
    trustedText = event.source === "extension" ? undefined : event.text;
  });
  pi.on("session_start", async (_event, ctx) => {
    await withEngine(dataRoot(), state(), async () => {});
    watcher?.close();
    blockerDb?.close();
    blockerDb = store();
    const notify = () => {
      for (const row of blockerDb!.prepare("SELECT * FROM ozi_blockers").all()) {
        if (notified.has(String(row.id))) continue;
        notified.add(String(row.id));
        ctx.ui.notify(String(row.detail), "warning");
      }
    };
    watcher = NodeFS.watch(state(), notify);
    notify();
    worker();
  });
  pi.on("session_shutdown", async () => {
    for (const release of reads.values()) await release();
    reads.clear();
    watcher?.close();
    watcher = undefined;
    blockerDb?.close();
    blockerDb = undefined;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    snapshot(ctx, true);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    for (const release of reads.values()) await release();
    reads.clear();
    const value = snapshot(ctx, false);
    const failed = value.entries.findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.stopReason === "error",
    );
    if (failed) {
      const db = store();
      try {
        logMistake(db, ctx.sessionManager.getSessionId(), {
          sourceEventId: failed.id,
          fingerprint: "runtime.provider-error",
          what: "Provider turn failed",
          why: "unknown",
        });
      } finally {
        db.close();
      }
    }
    worker();
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read" || typeof event.input.path !== "string") return;
    const target = NodePath.resolve(ctx.cwd, event.input.path);
    if (target === dataRoot() || target.startsWith(dataRoot() + NodePath.sep))
      reads.set(event.toolCallId, await acquireRoot(dataRoot()));
  });
  pi.on("tool_result", async (event) => {
    const release = reads.get(event.toolCallId);
    if (release) {
      reads.delete(event.toolCallId);
      await release();
    }
  });
}
