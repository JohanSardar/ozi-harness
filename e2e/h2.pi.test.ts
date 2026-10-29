import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { startAnthropic } from "./fakes/anthropic.ts";

it("h2.pi-package sends the data-root prompt each turn and reads data-root skills through real Pi and Claude Code", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ozi-h2-"));
  const dataRoot = NodePath.join(root, "data-root");
  const skill = NodePath.join(dataRoot, "skills/demo/SKILL.md");
  const prompt = await NodeFSP.readFile(
    new URL("../apps/server/src/ozi/defaults/system.md", import.meta.url),
    "utf8",
  );
  await NodeFSP.mkdir(NodePath.dirname(skill), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(dataRoot, "system.md"), prompt);
  await NodeFSP.writeFile(
    skill,
    "---\nname: demo\ndescription: h2-skill-description\n---\nh2-skill-loaded",
  );
  await NodeFSP.mkdir(NodePath.join(root, ".pi"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, ".pi/claude-bridge.json"),
    JSON.stringify({
      askClaude: { enabled: true },
      provider: { strictMcpConfig: false, autoMemoryEnabled: true },
    }),
  );
  const fake = await startAnthropic((input) => {
    if (JSON.stringify(input.messages).includes("h2-skill-loaded")) return { text: "h2-ok" };
    return {
      tool: "mcp__custom-tools__read",
      arguments: { path: skill },
    };
  });
  const pi = NodeChildProcess.spawn(
    NodeURL.fileURLToPath(new URL("./node_modules/.bin/pi", import.meta.url)),
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-context-files",
      "-e",
      NodeURL.fileURLToPath(new URL("../packages/ozi-pi", import.meta.url)),
      "--ozi-data-root",
      dataRoot,
    ],
    {
      cwd: root,
      env: {
        PATH: [
          NodeURL.fileURLToPath(new URL("./node_modules/.bin", import.meta.url)),
          NodePath.dirname(process.execPath),
          "/usr/bin",
          "/bin",
        ].join(":"),
        HOME: root,
        PI_CODING_AGENT_DIR: NodePath.join(root, "pi"),
        CLAUDE_CONFIG_DIR: NodePath.join(root, "claude"),
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ozi-test-only",
        ANTHROPIC_API_KEY: "must-not-be-used",
        ANTHROPIC_BASE_URL: fake.url,
        OZI_DATA_ROOT: NodePath.join(root, "wrong-root"),
      },
      stdio: "pipe",
    },
  );
  let stderr = "";
  pi.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = NodeReadline.createInterface({ input: pi.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const turn = async () => {
    pi.stdin.write(`${JSON.stringify({ type: "prompt", message: "Load demo and answer." })}\n`);
    for (;;) {
      const line = await iterator.next();
      if (line.done) throw new Error(`Pi exited: ${stderr}`);
      const event = JSON.parse(line.value);
      if (event.type === "agent_end") {
        expect(JSON.stringify(event), stderr).toContain("h2-ok");
        break;
      }
    }
  };
  try {
    await turn();
    const first = fake.requests.length;
    expect(first, stderr).toBeGreaterThanOrEqual(2);
    expect(fake.requests[0]?.system.map((block) => block.text).join("\n")).toContain(
      prompt.replaceAll("{{ADHD}}", ""),
    );
    expect(JSON.stringify(fake.requests[0]?.system)).toContain("h2-skill-description");
    expect(JSON.stringify(fake.requests.at(-1)?.messages)).toContain("h2-skill-loaded");
    await NodeFSP.writeFile(NodePath.join(dataRoot, "system.md"), `${prompt}\nh2-edited-prompt`);
    await NodeFSP.writeFile(NodePath.join(dataRoot, "adhd.md"), "h2-adhd");
    await turn();
    const second = fake.requests.slice(first);
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]?.system.map((block) => block.text).join("\n")).toContain(
      `${prompt.replaceAll("{{ADHD}}", "h2-adhd")}\nh2-edited-prompt`,
    );
    for (const request of fake.requests) {
      expect(request.model).toBe("claude-opus-5-5");
      expect(request.output_config?.effort).toBe("high");
      expect(request.speed).not.toBe("fast");
      expect(request.tools.some((tool) => tool.name.endsWith("__read"))).toBe(true);
      expect(request.tools.some((tool) => /AskClaude/.test(tool.name))).toBe(false);
      expect(request.tools.some((tool) => !tool.name.startsWith("mcp__custom-tools__"))).toBe(
        false,
      );
    }
    expect(JSON.stringify(fake.headers)).not.toContain("must-not-be-used");
  } finally {
    pi.kill("SIGTERM");
    await new Promise<void>((resolve) => pi.once("close", () => resolve()));
    lines.close();
    await fake.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
