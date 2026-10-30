import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { startAnthropic } from "./fakes/anthropic.ts";
import { startTickets } from "./fakes/tickets.ts";

const pkg = NodeURL.fileURLToPath(new URL("../packages/ozi-pi", import.meta.url));
const bin = NodeURL.fileURLToPath(new URL("./node_modules/.bin", import.meta.url));
const real = process.env.OZI_H3_REAL === "1";

async function check(mode: "package" | "gui-first" | "gui-last" | "no-mcp" | "fork") {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ozi-h3-"));
  const data = NodePath.join(root, "data");
  const agent = NodePath.join(root, "pi");
  await NodeFSP.mkdir(data);
  await NodeFSP.mkdir(agent);
  await NodeFSP.writeFile(
    NodePath.join(data, "system.md"),
    "You are Ozi. Answer the user. Use ticket tools only when checking a completed turn's inbox.",
  );
  const tickets = await startTickets();
  if (mode !== "no-mcp")
    await NodeFSP.writeFile(
      NodePath.join(agent, "mcp.json"),
      JSON.stringify({ mcpServers: { ozi: { url: tickets.url, exposure: "direct" } } }),
    );
  const gui = NodePath.join(root, "gui-inbox.ts");
  const source = await NodeFSP.readFile(NodePath.join(pkg, "src/inbox.ts"), "utf8");
  await NodeFSP.writeFile(gui, source);
  const extensions = ["-e", pkg];
  switch (mode) {
    case "gui-first":
      extensions.unshift("-e", gui);
      break;
    case "gui-last":
      extensions.push("-e", gui);
      break;
  }
  const fake = await startAnthropic((request) => {
    if (request.system.some((part) => part.text.includes("OZI COMPLETION CHECK")))
      return {
        text: JSON.stringify({
          verdict: { verdict: "done", useful: false },
          verified: ["The requested text was returned."],
        }),
      };
    const messages = JSON.stringify(request.messages);
    const at = messages.lastIndexOf("Check the completed turn's inbox only");
    if (at === -1) return { text: messages.includes("h3-smalltalk") ? "Hello!" : "h3-result" };
    const current = messages.slice(at);
    const call = (name: string, args: Record<string, unknown>) => ({
      tool: request.tools.find((tool) => tool.name.endsWith(`__${name}`))!.name,
      arguments: args,
    });
    if (!current.includes("tool_result")) return call("ticket_list", {});
    if (messages.includes("h3-acknowledged")) {
      if (!current.includes("archived")) return call("ticket_close", { id: "h3-ticket" });
    } else if (!messages.includes("h3-smalltalk") && !current.includes("h3-ticket")) {
      return call("ticket_create", {
        group: "Review",
        title: "h3-ticket",
        need: "Review the result.",
        summary: "The result is ready.",
        markdown: "h3-result",
        choices: [],
        attachments: [],
        htmlPages: [],
      });
    }
    return { text: "Inbox complete." };
  });
  const pi = NodeChildProcess.spawn(
    NodePath.join(bin, "pi"),
    ["--mode", "rpc", "--no-context-files", ...extensions, "--ozi-data-root", data],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: [bin, NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        HOME: root,
        PI_CODING_AGENT_DIR: agent,
        CLAUDE_CONFIG_DIR: NodePath.join(root, "claude"),
        CLAUDE_CODE_OAUTH_TOKEN: real
          ? process.env.CLAUDE_CODE_OAUTH_TOKEN!
          : "sk-ant-oat01-ozi-test-only",
        ANTHROPIC_BASE_URL: real ? "https://api.anthropic.com" : fake.url,
        OZI_MCP_URL: mode === "no-mcp" ? "" : tickets.url,
        OZI_INBOX_FORK: mode === "fork" ? "1" : "",
      },
      stdio: "pipe",
    },
  );
  const exited = new Promise<void>((resolve) => pi.once("close", () => resolve()));
  let stderr = "";
  pi.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = NodeReadline.createInterface({ input: pi.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const statuses: { key: string; status: string; filed: number; error?: string }[] = [];
  const next = async () => {
    const line = await iterator.next();
    if (line.done) throw new Error(`Pi exited: ${stderr}`);
    const event = JSON.parse(line.value);
    if (event.method === "setStatus" && event.statusKey.startsWith("ozi-inbox:"))
      statuses.push({ key: event.statusKey, ...JSON.parse(event.statusText) });
    return event;
  };
  const command = async (input: Record<string, unknown>) => {
    pi.stdin.write(`${JSON.stringify(input)}\n`);
    for (;;) {
      const event = await next();
      if (event.type === "response" && event.command === input.type) {
        expect(event.success, JSON.stringify(event)).toBe(true);
        return event.data;
      }
    }
  };
  const turn = async (message: string) => {
    await command({ type: "prompt", message });
    for (;;) {
      const event = await next();
      if (event.type === "agent_settled") break;
    }
    const state = await command({ type: "get_state" });
    const before = await NodeFSP.readFile(state.sessionFile, "utf8");
    if (mode === "package" || mode === "gui-first" || mode === "gui-last") {
      while (statuses.at(-1)?.status === "running" || statuses.length === 0) await next();
      expect(statuses.at(-1)?.status, JSON.stringify({ statuses, stderr })).toBe("completed");
      expect(await NodeFSP.readFile(state.sessionFile, "utf8")).toBe(before);
    }
    expect(before).not.toContain("Check the completed turn's inbox only");
    return before;
  };
  try {
    if (mode === "fork")
      await command({ type: "set_model", provider: "claude-bridge", modelId: "claude-opus-5-5" });
    if (!real) {
      await command({ type: "set_model", provider: "claude-bridge", modelId: "claude-sonnet-5-5" });
      await command({ type: "set_thinking_level", level: "medium" });
    }
    const first = await turn("Return only h3-result. This is a finished result for review.");
    expect(first, stderr).toContain("h3-result");
    if (mode === "no-mcp" || mode === "fork") {
      expect(statuses).toEqual([]);
      expect(tickets.calls).toEqual([]);
      expect(
        fake.requests.filter(
          (request) => !request.system.some((part) => part.text.includes("OZI COMPLETION CHECK")),
        ),
      ).toHaveLength(1);
      return;
    }
    expect(tickets.tickets).toHaveLength(1);
    expect(tickets.tickets[0]).toMatchObject({ group: "Review", status: "open" });
    expect(JSON.stringify(tickets.tickets[0])).toContain("h3-result");
    expect(statuses.at(-1)?.filed).toBe(1);
    if (real)
      process.stdout.write(
        `${JSON.stringify({ ticket: tickets.tickets[0], check: statuses.at(-1) })}\n`,
      );
    if (!real) {
      await turn("h3-smalltalk: hello, just small talk.");
      expect(statuses.at(-1)?.filed).toBe(0);
      expect(tickets.tickets).toHaveLength(1);
      await turn("h3-acknowledged: got it, close that result.");
      expect(tickets.tickets[0]?.status).toBe("archived");
      expect(tickets.calls.map((call) => call.name)).toEqual([
        "ticket_list",
        "ticket_create",
        "ticket_list",
        "ticket_list",
        "ticket_close",
      ]);
      expect(
        fake.requests.filter(
          (request) => !request.system.some((part) => part.text.includes("OZI COMPLETION CHECK")),
        ),
      ).toHaveLength(11);
      for (const request of fake.requests) {
        expect(request.model).toBe("claude-sonnet-5-5");
        expect(request.output_config?.effort).toBe(
          request.system.some((part) => part.text.includes("OZI COMPLETION CHECK"))
            ? "low"
            : "medium",
        );
        if (!JSON.stringify(request.messages).includes("Check the completed turn's inbox only"))
          continue;
        expect(request.tools).toHaveLength(4);
        expect(
          request.tools.every((tool) => /__ticket_(create|update|close|list)$/.test(tool.name)),
        ).toBe(true);
        expect(JSON.stringify(request.messages)).toContain("h3-result");
      }
    }
    const running = statuses.filter((status) => status.status === "running");
    expect(running).toHaveLength(real ? 1 : 3);
    expect(new Set(running.map((status) => status.key)).size).toBe(running.length);
  } finally {
    pi.kill("SIGTERM");
    await exited;
    lines.close();
    await fake.close();
    await tickets.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it("h3.pi-inbox plain Pi files from an isolated inbox fork", () => check("package"));
if (!real) {
  it("h3.gui-dedup GUI injection before the package installs once", () => check("gui-first"));
  it("h3.gui-dedup GUI injection after the package installs once", () => check("gui-last"));
  it("h3.no-mcp plain Pi without the GUI connection skips the check", () => check("no-mcp"));
  it("h3.fork inbox forks never install the check", () => check("fork"));
}
