import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function inbox(pi: ExtensionAPI) {
  if (process.env.OZI_INBOX_FORK === "1" || process.env.OZI_SUBAGENT === "1") return;
  let installed = false;
  pi.events.emit("ozi:inbox:installed", () => {
    installed = true;
  });
  if (installed) return;
  pi.events.on("ozi:inbox:installed", (acknowledge) => {
    if (typeof acknowledge === "function") acknowledge();
  });
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const { setTimeout, clearTimeout } = await import("node:timers");
  const { randomUUID } = await import("node:crypto");
  const children = new Set<ReturnType<typeof spawn>>();
  const prompt = `Check the completed turn's inbox only. Do not continue the task or answer the user.
Use ticket_list first to list open tickets. Close the listed tickets the user's last message acknowledged, using ticket_close. Never close a ticket merely because the assistant considers its work done.
File a ticket, with everything in it, for anything from this turn that needs the user's answer or acknowledgement: a question, approval, action only the user can take, finished result, failure, or something they should see. Use Decide, Do, Review or Read appropriately. Include the short title, one line saying what the user needs to do, a 2–4 line summary, choices when useful, full markdown detail, attachments and HTML pages where applicable. Use ticket_update for an existing matching ticket rather than duplicating it. File nothing if nothing fits; small talk gets none.
Use only ticket_create, ticket_update, ticket_close and ticket_list. The calling session's provenance is attached automatically.`;
  pi.on("session_shutdown", () => {
    for (const child of children) child.kill("SIGTERM");
  });
  pi.on("agent_settled", async (event, ctx) => {
    const session = ctx.sessionManager.getSessionFile();
    if (event.aborted || !session || !ctx.model || !process.env.OZI_MCP_URL) return;
    const key = `ozi-inbox:${randomUUID()}`;
    const report = (status: "running" | "completed" | "failed", filed = 0, error?: string) =>
      ctx.ui.setStatus(key, JSON.stringify({ status, filed, error }));
    report("running");
    let directory: string | undefined;
    try {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "ozi-inbox-"));
      const snapshot = path.join(directory, "source.jsonl");
      await fs.copyFile(session, snapshot);
      const context = process.env.OZI_PI_INBOX_CONTEXT_FILE;
      const runId = context ? (await fs.readFile(context, "utf8")).trim() : undefined;
      const original = process.argv.slice(2);
      const args: string[] = [];
      const replace = new Set([
        "--mode",
        "--session",
        "--session-id",
        "--session-dir",
        "--fork",
        "--provider",
        "--model",
        "--thinking",
        "--tools",
        "-t",
        "--exclude-tools",
        "-xt",
      ]);
      for (let i = 0; i < original.length; i++) {
        const arg = original[i]!;
        const name = arg.split("=", 1)[0]!;
        if (replace.has(name)) {
          if (!arg.includes("=")) i++;
        } else if (
          ![
            "--print",
            "-p",
            "--no-session",
            "--continue",
            "-c",
            "--resume",
            "-r",
            "--no-tools",
            "-nt",
            "--no-builtin-tools",
            "-nbt",
          ].includes(arg)
        ) {
          args.push(arg);
        }
      }
      const tools = pi
        .getAllTools()
        .filter(
          (tool) =>
            /(?:^|__)ticket_(?:create|update|close|list)$/.test(tool.name) &&
            tool.exposure !== "hidden",
        )
        .map((tool) => tool.name);
      if (tools.length !== 4) throw new Error("Inbox check requires all four ticket tools");
      const child = spawn(
        process.execPath,
        [
          process.argv[1]!,
          ...args,
          "--fork",
          snapshot,
          "--session-dir",
          directory,
          "--mode",
          "json",
          "--print",
          "--provider",
          ctx.model.provider,
          "--model",
          ctx.model.id,
          "--thinking",
          pi.getThinkingLevel(),
          "--tools",
          tools.join(","),
          prompt,
        ],
        {
          cwd: ctx.cwd,
          env: {
            ...process.env,
            OZI_INBOX_FORK: "1",
            ...(runId ? { OZI_INBOX_RUN_ID: runId } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      let filed = 0;
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (
            event.type === "tool_execution_end" &&
            /(?:^|__)ticket_create$/.test(event.toolName ?? "") &&
            !event.isError &&
            !event.result?.isError
          )
            filed++;
        } catch {}
      });
      const cleanup = () => {
        children.delete(child);
        lines.close();
        void fs.rm(directory!, { recursive: true, force: true });
      };
      const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
      child.once("error", () => {
        clearTimeout(timeout);
        report("failed", filed);
        cleanup();
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        report(code === 0 ? "completed" : "failed", filed, code === 0 ? undefined : stderr);
        cleanup();
      });
    } catch {
      report("failed");
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
