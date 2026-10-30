import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { startAnthropic } from "./fakes/anthropic.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const pkg = NodeURL.fileURLToPath(new URL("../packages/ozi-pi", import.meta.url));
const cli = NodePath.join(pkg, "src/cli.mjs");
const bin = NodeURL.fileURLToPath(new URL("./node_modules/.bin", import.meta.url));
const fixed = "For math questions answer only 42 exactly.\n";

async function check(
  mode:
    | "repair"
    | "protected"
    | "symlink"
    | "observer"
    | "conflict"
    | "recurrence"
    | "unknown-effect"
    | "crash-undo"
    | "long-path"
    | "skills",
) {
  const real = process.env.OZI_H4_REAL === "1";
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ozi-h4-"));
  const data = NodePath.join(root, mode === "long-path" ? "data-".repeat(24) : "data");
  await NodeFSP.mkdir(NodePath.join(data, "protected"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(data, "system.md"), "For math questions answer only 42.\n");
  await NodeFSP.writeFile(NodePath.join(data, "protected/rule.md"), "Keep this rule.\n");
  const skill = NodePath.join(data, "skills/demo/SKILL.md");
  if (mode === "skills") {
    await NodeFSP.mkdir(NodePath.dirname(skill), { recursive: true });
    await NodeFSP.writeFile(
      skill,
      "---\nname: demo\ndescription: Math formatting\n---\nmath-skill: answer 42.\n",
    );
  }
  let correction: Record<string, string> = {};
  const fake = await startAnthropic((input) => {
    const system = input.system.map((block) => block.text).join("\n");
    const messages = JSON.stringify(input.messages);
    const requestIndex = input.messages.findLastIndex(
      (message) =>
        message.role === "user" &&
        (typeof message.content === "string" ||
          (Array.isArray(message.content) && message.content.some((part) => part.type === "text"))),
    );
    const request = JSON.stringify(input.messages[requestIndex]);
    const currentMessages = JSON.stringify(input.messages.slice(requestIndex + 1));
    if (system.includes("confined repair author")) {
      if (messages.includes('"tool_result"')) return { text: "authored" };
      if (mode === "symlink")
        return {
          tool: input.tools.find((tool) => tool.name.endsWith("__bash"))!.name,
          arguments: { command: "ln -s /missing /data/system.md.link" },
        };
      return {
        tool: input.tools.find((tool) => tool.name.endsWith("__write"))!.name,
        arguments: {
          path:
            mode === "protected"
              ? "/data/protected/rule.md"
              : mode === "skills"
                ? "/data/skills/demo/SKILL.md"
                : "/data/system.md",
          content:
            mode === "skills"
              ? "---\nname: demo\ndescription: Math formatting\n---\nmath-skill: answer 42 exactly.\n"
              : fixed,
        },
      };
    }
    if (system.includes("Independently judge"))
      return {
        text: JSON.stringify({
          baselineReproduced: true,
          candidatePassed: true,
          agrees: mode !== "observer",
          evidence: "Baseline: 42. Candidate: 42 exactly.",
        }),
      };
    if (request.includes("Please fix")) {
      if (messages.includes("logged")) return { text: "Logged." };
      const content = input.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as { type: string; content?: { text?: string }[] | string }[])
          : [],
      );
      const context = content
        .filter((part) => part.type === "tool_result")
        .flatMap((part) => (Array.isArray(part.content) ? part.content : []))
        .map((part) => part.text)
        .find((text) => text?.startsWith('[{"id"'));
      if (!context)
        return {
          tool: input.tools.find((tool) => tool.name.endsWith("__repair_context"))!.name,
          arguments: {},
        };
      const entries = JSON.parse(context) as { id: string; role: string }[];
      correction.correctionMessageId = entries.findLast((entry) => entry.role === "user")!.id;
      return {
        tool: input.tools.find((tool) => tool.name.endsWith("__log_mistake"))!.name,
        arguments: correction,
      };
    }
    if (
      mode === "unknown-effect" &&
      system.includes("42 exactly") &&
      !messages.includes("Unknown replay effect.")
    )
      return {
        tool: input.tools.find((tool) => tool.name.endsWith("__bash"))!.name,
        arguments: { command: "touch /effect" },
      };
    if (mode === "skills") {
      if (!currentMessages.includes("math-skill:"))
        return {
          tool: input.tools.find((tool) => tool.name.endsWith("__read"))!.name,
          arguments: { path: skill },
        };
      return {
        text: currentMessages.includes("math-skill: answer 42 exactly") ? "42 exactly" : "42",
      };
    }
    return { text: system.includes("42 exactly") ? "42 exactly" : "42" };
  });
  const env = {
    ...process.env,
    PATH: [bin, NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    PI_CODING_AGENT_DIR: NodePath.join(root, "pi"),
    CLAUDE_CONFIG_DIR: NodePath.join(root, "claude"),
    CLAUDE_CODE_OAUTH_TOKEN: real
      ? process.env.CLAUDE_CODE_OAUTH_TOKEN!
      : "sk-ant-oat01-ozi-h4-test-only",
    ANTHROPIC_BASE_URL: real ? "https://api.anthropic.com" : fake.url,
  };
  const ozi = async <A>(...args: string[]): Promise<A> =>
    JSON.parse(
      (
        await exec(process.execPath, [cli, ...args, "--data-root", data, "--json"], {
          env,
          timeout: 150000,
        })
      ).stdout,
    );
  const pi = NodeChildProcess.spawn(
    NodePath.join(bin, "pi"),
    [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-mcp",
      "--no-context-files",
      "-e",
      pkg,
      "--ozi-data-root",
      data,
    ],
    { cwd: root, env, stdio: "pipe" },
  );
  let stderr = "";
  pi.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = NodeReadline.createInterface({ input: pi.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const turn = async (message: string, before?: () => Promise<void>) => {
    pi.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
    let reply = "";
    for (;;) {
      const line = await iterator.next();
      if (line.done) throw new Error(`Pi exited: ${stderr}`);
      const frame = JSON.parse(line.value);
      if (frame.type === "message_start" && frame.message?.role === "user" && before)
        await before();
      if (frame.type === "agent_end") reply = JSON.stringify(frame);
      if (frame.type === "agent_settled") return reply;
    }
  };
  try {
    expect(await turn("What is six times seven?"), stderr).toContain("42");
    const sessions = await ozi<{ id: string }[]>("sessions");
    const session = sessions[0]!.id;
    const events = await ozi<{
      entries: { id: string; type: string; message?: { role: string } }[];
    }>("events", session);
    const source = events.entries.findLast((entry) => entry.message?.role === "assistant")!;
    const before = events.entries.findLast((entry) => entry.message?.role === "user")!;
    correction = {
      sourceEventId: source.id,
      beforeUserMessageId: before.id,
      fingerprint: "answer-exactly",
      what: "Omitted exactly",
      why: "Missing formatting rule",
    };
    const logged = await ozi<{ id: string }>(
      "mistakes",
      "log",
      "--session",
      session,
      "--input",
      JSON.stringify(correction),
    );
    expect(await ozi("replays")).toEqual([]);
    pi.stdin.write(
      `${JSON.stringify({ type: "prompt", message: "Please fix this. Answer math with exactly after the number. Use repair_context to get IDs, then log_mistake for the earlier answer with fingerprint answer-exactly and this user message as correctionMessageId. Do not change files yourself; logging starts the confined repair." })}\n`,
    );
    for (;;) {
      const line = await iterator.next();
      if (line.done) throw new Error(stderr);
      const frame = JSON.parse(line.value);
      if (frame.type === "agent_settled") break;
    }
    const rows = await ozi<{ id: string; status: string }[]>("mistakes");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(logged.id);
    const replay = await ozi<{ state: string; reason: string; evidence_json: string }>(
      "wait",
      "replay",
      logged.id,
      "finished",
      "--timeout",
      "120",
    );
    if (["protected", "symlink", "observer", "unknown-effect"].includes(mode)) {
      expect(replay.state, replay.evidence_json).toBe("failed");
      expect(replay.reason).toBe(
        mode === "symlink"
          ? "symlink-denied"
          : mode === "observer"
            ? "observer-verdict-invalid"
            : mode === "unknown-effect"
              ? "unknown-effect"
              : "publisher-empty-diff",
      );
      expect(await ozi("fixes")).toEqual([]);
      expect(await NodeFSP.readFile(NodePath.join(data, "protected/rule.md"), "utf8")).toBe(
        "Keep this rule.\n",
      );
      return;
    }
    expect(replay.state, replay.evidence_json).toBe("passed");
    const fix = await ozi<{ state: string; commit_sha: string }>(
      "wait",
      "fix",
      logged.id,
      "shipped",
    );
    expect(fix.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(await turn("What is six times seven?"), stderr).toContain("42 exactly");
    const evidence = JSON.parse(replay.evidence_json);
    expect(evidence.baseline.command).toContain("--unshare-all");
    if (real) {
      expect(evidence.baseline.evidence.transcript.join("\n")).toContain("42");
      expect(evidence.candidate.evidence.transcript.join("\n")).toMatch(/42\s+exactly/);
    } else {
      expect(evidence.baseline.evidence.transcript).toEqual(["42"]);
      expect(evidence.candidate.evidence.transcript).toEqual(["42 exactly"]);
    }
    expect(replay.evidence_json).not.toContain(env.CLAUDE_CODE_OAUTH_TOKEN);
    await NodeFSP.writeFile(NodePath.join(data, "unrelated.txt"), "Later user edit");
    if (mode === "conflict")
      await NodeFSP.writeFile(NodePath.join(data, "system.md"), "A later conflicting user edit.\n");
    if (mode === "recurrence") {
      const current = await ozi<{ entries: { id: string; message?: { role: string } }[] }>(
        "events",
        session,
      );
      await ozi(
        "mistakes",
        "log",
        "--session",
        session,
        "--input",
        JSON.stringify({
          ...correction,
          correctionMessageId: undefined,
          sourceEventId: current.entries.findLast((entry) => entry.message?.role === "assistant")!
            .id,
          beforeUserMessageId: undefined,
        }),
      );
      await ozi("worker");
      expect(await ozi<unknown[]>("replays")).toHaveLength(1);
    }
    if (mode === "crash-undo") {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [cli, "undo", logged.id, "--data-root", data, "--json"],
        { env: { ...env, OZI_TEST_REPAIR_PAUSE: "undo:journal" }, stdio: "ignore" },
      );
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      try {
        await ozi("wait", "fix", logged.id, "at:undo:journal");
        child.kill("SIGKILL");
        await closed;
        expect(await turn("What is six times seven?"), stderr).not.toContain("42 exactly");
      } finally {
        child.kill("SIGKILL");
      }
    }
    expect(await ozi<{ state: string }>("undo", logged.id)).toMatchObject({
      state: "undone",
      conflict: mode === "conflict" ? 1 : 0,
    });
    expect(await ozi<{ state: string }>("undo", logged.id)).toMatchObject({ state: "undone" });
    expect(await NodeFSP.readFile(NodePath.join(data, "system.md"), "utf8")).toBe(
      "For math questions answer only 42.\n",
    );
    expect(await NodeFSP.readFile(NodePath.join(data, "unrelated.txt"), "utf8")).toBe(
      "Later user edit",
    );
    expect(await NodeFSP.readFile(NodePath.join(data, "protected/rule.md"), "utf8")).toBe(
      "Keep this rule.\n",
    );
    if (mode === "conflict") {
      expect(await ozi<unknown[]>("blockers")).toHaveLength(1);
      const user = await exec("git", ["show", `refs/ozi/user-builds/${logged.id}:system.md`], {
        cwd: data,
      });
      expect(user.stdout).toBe("A later conflicting user edit.\n");
    }
  } finally {
    pi.kill("SIGTERM");
    await new Promise<void>((resolve) => pi.once("close", () => resolve()));
    lines.close();
    await fake.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it("h4.repair logs, replays, publishes and undoes without a GUI server", () => check("repair"));
if (process.env.OZI_H4_REAL !== "1") {
  for (const mode of [
    "protected",
    "symlink",
    "observer",
    "unknown-effect",
    "conflict",
    "recurrence",
    "crash-undo",
    "skills",
  ] as const)
    it(`h4.${mode}`, () => check(mode));
}

it("h4.long-path C6 repair publishes and undoes under a deeply nested data root", () =>
  check("long-path"));

if (process.env.OZI_H4_REAL !== "1")
  it("h4.package CLI runs when installed under node_modules", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ozi-h4-package-"));
    try {
      const installed = NodePath.join(root, "node_modules/@ozi/pi");
      await NodeFSP.mkdir(installed, { recursive: true });
      await NodeFSP.cp(NodePath.join(pkg, "src"), NodePath.join(installed, "src"), {
        recursive: true,
      });
      await NodeFSP.copyFile(
        NodePath.join(pkg, "package.json"),
        NodePath.join(installed, "package.json"),
      );
      await NodeFSP.symlink(
        NodePath.join(pkg, "node_modules"),
        NodePath.join(installed, "node_modules"),
      );
      const result = await exec(process.execPath, [
        NodePath.join(installed, "src/cli.mjs"),
        "mistakes",
        "--data-root",
        NodePath.join(root, "data"),
        "--json",
      ]);
      expect(JSON.parse(result.stdout)).toEqual([]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
