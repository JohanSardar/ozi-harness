import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
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
const content = {
  group: "Review",
  title: "Worker result",
  need: "Review the change.",
  summary: "Worker changed the answer to 42.",
  choices: [],
  markdown: "answer.txt contains 42; inspect before accepting.",
  attachments: [],
  htmlPages: [],
};

async function run(
  mode:
    | "done"
    | "continue"
    | "blocked"
    | "needs_user"
    | "malformed"
    | "stale"
    | "update"
    | "file-error"
    | "file-stale"
    | "duplicate"
    | "inbox-worker"
    | "task-id"
    | "task-duplicate"
    | "task-blocked"
    | "task-unbound",
) {
  const taskMode = mode.startsWith("task-");
  const blocked = mode === "blocked" || mode === "task-blocked";
  const duplicate = mode === "duplicate" || mode === "task-duplicate";
  const passed = mode === "done" || mode === "update" || mode === "task-id" || duplicate;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ozi-h5-"));
  const data = NodePath.join(root, "data");
  const real = process.env.OZI_H5_REAL === "1";
  await NodeFSP.mkdir(data);
  await NodeFSP.mkdir(NodePath.join(root, "pi"));
  await NodeFSP.writeFile(
    NodePath.join(data, "system.md"),
    "You are Ozi. Follow the user's instructions and use the tools.",
  );
  await NodeFSP.writeFile(NodePath.join(root, "answer.txt"), "42\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "answer.txt"], { cwd: root });
  await exec(
    "git",
    [
      "-c",
      "user.name=Ozi",
      "-c",
      "user.email=ozi@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ],
    { cwd: root },
  );
  await NodeFSP.writeFile(NodePath.join(root, "answer.txt"), "42 exactly\n");
  const diff = await exec("git", ["diff", "--", "answer.txt"], { cwd: root });
  await NodeFSP.writeFile(NodePath.join(root, "diff.txt"), diff.stdout);
  let revision = 1;
  const mcp = await startCompletionMcp(
    () => ({
      thread: {
        threadId: "worker-1",
        activeRunId: null,
        latestRunId: "run-1",
        pendingRequestCount: 0,
        updatedAt: revision,
      },
      recentRuns: [{ runId: "run-1", status: "completed" }],
      items: [
        {
          itemId: "report-1",
          type: "assistant_message",
          text: "Done: answer.txt says 42 exactly.",
          textTruncated: false,
        },
      ],
      hasMore: false,
      nextPosition: null,
    }),
    taskMode ? { "task-1": mode === "task-unbound" ? null : "worker-1" } : undefined,
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "pi/mcp.json"),
    JSON.stringify({ mcpServers: { ozi: { url: mcp.url, exposure: "direct" } } }),
  );
  let step = 0;
  let checkerCount = 0;
  let inboxStep = 0;
  const fake = await startAnthropic((request) => {
    const system = request.system.map((part) => part.text).join("\n");
    if (system.includes("OZI COMPLETION CHECK")) {
      if (JSON.stringify(request.messages.at(-1)).includes('"claimant":"main"'))
        return {
          text: JSON.stringify({
            verdict: { verdict: "done", useful: false },
            verified: ["Main coordinated the worker check."],
          }),
        };
      checkerCount++;
      expect(request.tools).toEqual([]);
      expect(request.output_config?.effort).toBe("low");
      expect(system).not.toContain("Before reporting a worker's finished job");
      if (mode === "stale") revision++;
      if (mode === "file-stale")
        NodeFS.writeFileSync(NodePath.join(root, "answer.txt"), "Changed after check.\n");
      if (mode === "malformed") return { text: "Looks done to me." };
      const verdict =
        mode === "continue" || blocked
          ? {
              verdict: "continue",
              missing: "The requested test has not run; run it and include its output.",
              evidence: [],
              useful: true,
            }
          : mode === "needs_user"
            ? { verdict: "needs_user", reason: "Release needs the user's approval.", useful: true }
            : { verdict: "done", useful: true };
      return {
        text: JSON.stringify({
          verdict,
          verified:
            verdict.verdict === "done"
              ? [
                  "answer.txt hash and git diff confirm 42 exactly; tests and PR were not requested.",
                ]
              : [],
        }),
      };
    }
    const call = (suffix: string, args: Record<string, unknown>) => {
      const tool = request.tools.find((tool) => tool.name.endsWith(suffix));
      if (!tool) return { text: `Missing ${suffix}: ${JSON.stringify(request.tools)}` };
      return { tool: tool.name, arguments: args };
    };
    if (
      mode === "inbox-worker" &&
      JSON.stringify(request.messages).includes("Check the completed turn's inbox only")
    ) {
      if (inboxStep++ === 0) return call("ticket_list", {});
      if (inboxStep === 2) return call("ticket_create", content);
      return { text: "Inbox complete." };
    }
    const stage = step++;
    if (mode === "inbox-worker")
      return stage === 0
        ? call("ozi_thread_read", { threadId: "worker-1" })
        : { text: "The worker claims it is done." };
    if (stage === 0) return call("ticket_create", content);
    if (stage === 1)
      return call("ticket_update", {
        id: "existing",
        changes: { group: "Review", summary: "unchecked promotion" },
      });
    if (stage === 2)
      return call("ticket_update", { id: "existing", changes: { summary: "unchecked promotion" } });
    if (stage === 3)
      return call("completion_check", {
        workerId: taskMode ? "task-1" : "worker-1",
        files: mode === "file-error" ? ["missing.txt"] : ["answer.txt", "diff.txt"],
        ticket: content,
        ...(mode === "update" ? { ticketId: "existing" } : {}),
      });
    if ((blocked && stage < 6) || (duplicate && stage === 4))
      return call("completion_check", {
        workerId: taskMode && stage === 5 ? "task-1" : "worker-1",
        files: ["answer.txt", "diff.txt"],
        ticket: content,
      });
    return { text: "h5-finished" };
  });
  const env = {
    ...process.env,
    PATH: [bin, NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    PI_CODING_AGENT_DIR: NodePath.join(root, "pi"),
    CLAUDE_CONFIG_DIR: NodePath.join(root, "claude"),
    CLAUDE_CODE_OAUTH_TOKEN: real
      ? process.env.CLAUDE_CODE_OAUTH_TOKEN!
      : "sk-ant-oat01-ozi-test-only",
    ANTHROPIC_BASE_URL: real ? "https://api.anthropic.com" : fake.url,
    OZI_MCP_URL: mode === "inbox-worker" ? mcp.url : "",
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
  let stderr = "";
  pi.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = NodeReadline.createInterface({ input: pi.stdout });
  try {
    const message = real
      ? `Check worker-1's completed job: write the literal text "42 exactly" followed by a newline to answer.txt. No tests or PR were requested. Read answer.txt and diff.txt; use completion_check with workerId worker-1, files ["answer.txt","diff.txt"], and a Review ticket. Do not claim tests or PR checks. File the ticket through completion_check, then stop.`
      : mode === "continue" || blocked
        ? "Check worker-1's required file change and test run. A real passing test output is required. Use completion_check."
        : mode === "needs_user"
          ? "Check worker-1's result; release needs my approval. Use completion_check."
          : "Check worker-1's change to answer.txt; no tests or PR required. Use completion_check.";
    pi.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
    let output = "";
    for await (const line of lines) {
      const event = JSON.parse(line);
      output += line;
      if (mode === "inbox-worker") {
        if (event.method === "setStatus" && event.statusText?.includes('"status":"completed"'))
          break;
      } else if (event.type === "agent_settled") break;
    }
    const records = (await cli("checks")).filter(
      (row: { workerId: string | null }) => row.workerId !== null,
    );
    if (mode === "inbox-worker") {
      expect(inboxStep).toBe(3);
      expect(records).toEqual([]);
      expect(mcp.tickets).toEqual([]);
      expect(mcp.calls.some((call) => call.name === "ticket_create")).toBe(false);
      return;
    }
    expect(records.length, stderr + output.slice(-1200)).toBeGreaterThan(0);
    const last = records.at(-1);
    const expected = passed
      ? "checked"
      : mode === "continue"
        ? "continued"
        : blocked
          ? "blocked"
          : mode === "needs_user"
            ? "needs_user"
            : mode === "stale" || mode === "file-stale"
              ? "superseded"
              : "failed";
    expect(last.state, JSON.stringify(records) + stderr + output.slice(-1200)).toBe(expected);
    expect(await cli("wait", "check", last.id, expected, "--timeout", "5")).toEqual(last);
    expect(
      mcp.calls
        .filter((call) => call.name === "ticket_create")
        .some((call) => call.input.markdown === content.markdown),
    ).toBe(false);
    expect(
      mcp.calls.some(
        (call) =>
          call.input.id === "existing" &&
          JSON.stringify(call.input).includes("unchecked promotion"),
      ),
    ).toBe(false);
    if (passed) {
      expect(mcp.tickets).toHaveLength(1);
      expect(mcp.tickets[0]!.group).toBe("Review");
      expect(mcp.tickets[0]!.markdown).toContain("Verified by completion check");
      expect(last.evidence).toHaveLength(2);
      expect(last.verified[0]).toContain("42 exactly");
    } else if (mode === "continue" || blocked) {
      expect(mcp.calls.filter((call) => call.name === "ozi_thread_send")).toHaveLength(
        blocked ? 2 : 1,
      );
      expect(mcp.tickets.filter((ticket) => ticket.group === "Review")).toHaveLength(0);
      if (blocked) {
        expect(last.unsuccessfulRounds).toBe(3);
        expect(mcp.tickets[0]!.group).toBe("Read");
      }
    } else if (mode === "stale" || mode === "file-stale") expect(mcp.tickets).toEqual([]);
    else {
      expect(mcp.tickets[0]!.group).toBe(mode === "needs_user" ? "Decide" : "Read");
    }
    if (taskMode && mode !== "task-unbound") {
      expect(records.every((record: { workerId: string }) => record.workerId === "worker-1")).toBe(
        true,
      );
      expect(
        mcp.calls
          .filter((call) => call.name === "ozi_thread_read")
          .every((call) => call.input.threadId === "worker-1"),
      ).toBe(true);
      expect(
        mcp.calls
          .filter((call) => call.name === "ozi_thread_send")
          .every((call) => call.input.threadId === "worker-1"),
      ).toBe(true);
      if (duplicate) expect(records).toHaveLength(1);
    }
    if (!real && mode !== "file-error")
      expect(checkerCount).toBe(mode === "task-unbound" ? 0 : blocked ? 3 : 1);
  } finally {
    pi.kill("SIGTERM");
    await new Promise<void>((resolve) => pi.once("close", () => resolve()));
    lines.close();
    await fake.close();
    await mcp.close();
    await NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

it("h5.review verifies evidence before filing a Review through GUI MCP", () => run("done"));
if (process.env.OZI_H5_REAL !== "1") {
  for (const mode of [
    "continue",
    "blocked",
    "needs_user",
    "malformed",
    "stale",
    "update",
    "file-error",
    "file-stale",
    "duplicate",
    "inbox-worker",
  ] as const)
    it(`h5.${mode.replaceAll("_", "-")} fails closed or routes the checked outcome`, () =>
      run(mode));
}

for (const mode of ["task-id", "task-duplicate", "task-blocked", "task-unbound"] as const)
  it(`h7.${mode} resolves delegated IDs consistently`, () => run(mode));
