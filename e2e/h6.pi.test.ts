import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { startAnthropic } from "./fakes/anthropic.ts";
import { startCompletionMcp } from "./fakes/completion-mcp.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const pkg = NodePath.resolve(import.meta.dirname, "../packages/ozi-pi");
const bin = NodePath.resolve(import.meta.dirname, "node_modules/.bin");

async function run(
  mode: "done" | "continue" | "blocked" | "malformed" | "fork" | "needs_user" | "superseded",
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ozi-h6-"));
  const data = NodePath.join(root, "data");
  const agent = NodePath.join(root, "pi");
  await NodeFSP.mkdir(data);
  await NodeFSP.mkdir(agent);
  await NodeFSP.writeFile(NodePath.join(data, "system.md"), "You are Ozi. Follow the user.");
  const mcp = await startCompletionMcp(() => ({}));
  await NodeFSP.writeFile(
    NodePath.join(agent, "mcp.json"),
    JSON.stringify({ mcpServers: { ozi: { url: mcp.url, exposure: "direct" } } }),
  );
  let checkerCount = 0;
  let delegated = false;
  let replace: () => void;
  let release: (() => void) | undefined;
  const fake = await startAnthropic(async (request) => {
    const system = request.system.map((part) => part.text).join("\n");
    const messages = JSON.stringify(request.messages);
    if (system.includes("OZI COMPLETION CHECK")) {
      checkerCount++;
      expect(request.tools).toEqual([]);
      expect(request.output_config?.effort).toBe("low");
      expect(messages).toContain("h6-claim");
      expect(system).not.toContain("Before reporting a worker");
      if (mode === "superseded" && checkerCount === 1) {
        replace();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          text: JSON.stringify({
            verdict: { verdict: "continue", missing: "Old obligation", evidence: [], useful: true },
            verified: [],
          }),
        };
      }
      if (mode === "malformed") return { text: "unverified" };
      return {
        text: JSON.stringify({
          verdict:
            mode === "blocked" || (mode === "continue" && !delegated)
              ? {
                  verdict: "continue",
                  missing: "Delegate the remaining action.",
                  evidence: [],
                  useful: true,
                }
              : mode === "needs_user"
                ? { verdict: "needs_user", reason: "The user must approve release.", useful: true }
                : { verdict: "done", useful: false },
          verified: ["The inherited conversation establishes the reply."],
        }),
      };
    }
    if (messages.includes("h6-replacement")) release?.();
    if (messages.includes("Completion check found missing work") && !delegated) {
      expect(messages).toContain("delegate_task");
      delegated = true;
      return {
        tool: request.tools.find((tool) => tool.name.endsWith("__delegate_task"))!.name,
        arguments: { task: "Finish the remaining action." },
      };
    }
    return { text: delegated ? "h6-coordinated" : "h6-claim" };
  });
  const env = {
    ...process.env,
    PATH: [bin, NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    PI_CODING_AGENT_DIR: agent,
    CLAUDE_CONFIG_DIR: NodePath.join(root, "claude"),
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ozi-test-only",
    ANTHROPIC_BASE_URL: fake.url,
    OZI_MCP_URL: "",
    OZI_INBOX_FORK: mode === "fork" ? "1" : "",
  };
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [NodePath.join(pkg, "src/cli.mjs"), ...args, "--data-root", data, "--json"],
          { env },
        )
      ).stdout,
    );
  const pi = NodeChildProcess.spawn(
    NodePath.join(bin, "pi"),
    ["--mode", "rpc", "--no-context-files", "-e", pkg, "--ozi-data-root", data],
    { cwd: root, env, stdio: "pipe" },
  );
  const exited = new Promise<void>((resolve) => pi.once("close", () => resolve()));
  replace = () =>
    pi.stdin.write(
      JSON.stringify({ type: "prompt", message: "h6-replacement: just reply h6-claim." }) + "\n",
    );
  let stderr = "";
  pi.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = NodeReadline.createInterface({ input: pi.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const next = async () => {
    const line = await iterator.next();
    if (line.done) throw new Error(stderr);
    return JSON.parse(line.value);
  };
  const command = async (input: Record<string, unknown>) => {
    pi.stdin.write(JSON.stringify(input) + "\n");
    for (;;) {
      const event = await next();
      if (event.type === "response" && event.command === input.type) return event.data;
    }
  };
  try {
    if (mode === "fork")
      await command({ type: "set_model", provider: "claude-bridge", modelId: "claude-opus-5-5" });
    await command({
      type: "prompt",
      message: "h6-request: complete the task and report h6-claim.",
    });
    for (;;) {
      if ((await next()).type !== "agent_settled") continue;
      const records = await cli("checks");
      if (mode === "fork") {
        expect(records).toEqual([]);
        expect(checkerCount).toBe(0);
        return;
      }
      expect(records.length, stderr).toBeGreaterThan(0);
      const last = records.at(-1);
      const settled = await cli("wait", "check", last.id, "finished", "--timeout", "20");
      if (mode === "superseded" && settled.state === "superseded") continue;
      if ((mode === "continue" || mode === "blocked") && settled.state === "continued") continue;
      expect(records.every((row: { workerId: string | null }) => row.workerId === null)).toBe(true);
      expect(settled.state).toBe(
        mode === "blocked"
          ? "blocked"
          : mode === "malformed"
            ? "failed"
            : mode === "needs_user"
              ? "needs_user"
              : "checked",
      );
      expect(checkerCount).toBe(
        mode === "blocked" ? 3 : mode === "continue" || mode === "superseded" ? 2 : 1,
      );
      expect(mcp.calls.filter((call) => call.name === "delegate_task")).toHaveLength(
        mode === "continue" || mode === "blocked" ? 1 : 0,
      );
      if (mode === "done") {
        const state = await command({ type: "get_state" });
        const source = await NodeFSP.readFile(state.sessionFile, "utf8");
        expect(
          await NodeFSP.readFile(
            NodePath.join(root, ".data-harness/checks", last.id, "source.jsonl"),
            "utf8",
          ),
        ).toBe(source);
        expect(source).not.toContain("OZI COMPLETION CHECK");
        expect(source).not.toContain("The inherited conversation establishes");
        await command({ type: "prompt", message: "Recall the original request." });
        for (;;) {
          if ((await next()).type === "agent_settled") break;
        }
        expect((await cli("checks")).length).toBe(2);
      }
      if (mode === "blocked") expect(settled.unsuccessfulRounds).toBe(3);
      if (mode === "superseded") {
        expect(records[0].state).toBe("superseded");
        expect(records[0].action).toBeNull();
        expect(records[0].request).not.toBe(last.request);
      }
      break;
    }
  } finally {
    pi.kill("SIGTERM");
    await exited;
    lines.close();
    await fake.close();
    await mcp.close();
    await NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

it("h6.main-checked automatically checks a text-only main claim and delegates gaps", () =>
  run("continue"));
it("h6.fork-intact a passing fork leaves native history usable and unchanged", () => run("done"));
it("h6.no-recursion inbox forks never check themselves", () => run("fork"));
it("h6.blocked three rounds without verified progress stop continuation", () => run("blocked"));
it("h6.malformed checker errors never pass or continue main", () => run("malformed"));
it("h6.needs-user human needs never resume main", () => run("needs_user"));
it("h6.superseded a new request starts during checking and invalidates the old continuation", () =>
  run("superseded"));
