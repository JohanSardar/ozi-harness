import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { PI_BUILTIN_TOOL_NAMES } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { startHarness } from "./harness.ts";
import { startAnthropic } from "./fakes/anthropic.ts";

it("m1.main-loadout sends Pi and Ozi tools and the data-root prompt through real Pi and Claude Code", async () => {
  const pi = NodeURL.fileURLToPath(new URL("./node_modules/.bin/pi", import.meta.url));
  const claude = NodeURL.fileURLToPath(new URL("./node_modules/.bin", import.meta.url));
  const fake = await startAnthropic();
  const h = await startHarness({
    bundled: true,
    pi: {
      binaryPath: pi,
      env: {
        PATH: [
          claude,
          NodeURL.fileURLToPath(new URL("./fakes", import.meta.url)),
          NodePath.dirname(process.execPath),
          "/usr/bin",
          "/bin",
        ].join(":"),
        ANTHROPIC_BASE_URL: fake.url,
        ANTHROPIC_API_KEY: "ozi-test-only",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_FAST_MODE: "0",
        ENABLE_TOOL_SEARCH: "true",
      },
    },
  }).catch(async (error: unknown) => {
    await fake.close();
    throw error;
  });
  try {
    await h.ozi("wait", "provider", "pi", "ready", "--timeout", "30");
    const provider = (await h.status()).server.providers.find((entry) => entry.driver === "pi");
    expect(provider, JSON.stringify(provider)).toMatchObject({ installed: true });
    expect(
      provider?.models.map((model) => model.slug),
      JSON.stringify(provider),
    ).toContain("claude-bridge/claude-opus-5-5");
    const workspace = NodePath.join(h.home, "workspace");
    const claudeHome = NodePath.join(h.root, "claude");
    const hook = NodePath.join(h.root, "ambient-hook");
    await NodeFSP.mkdir(NodePath.join(workspace, ".pi"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(workspace, ".pi/claude-bridge.json"),
      JSON.stringify({ askClaude: { enabled: true }, provider: { strictMcpConfig: false } }),
    );
    const settings = {
      fastMode: true,
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${hook}` }] }] },
    };
    for (const directory of [claudeHome, NodePath.join(workspace, ".claude")]) {
      await NodeFSP.mkdir(NodePath.join(directory, "skills/ambient"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(directory, "settings.json"), JSON.stringify(settings));
      await NodeFSP.writeFile(
        NodePath.join(directory, "CLAUDE.md"),
        "ambient-context-must-not-load",
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "skills/ambient/SKILL.md"),
        "---\nname: ambient\ndescription: ambient-skill-must-not-load\n---\nambient-skill-must-not-load",
      );
    }
    await NodeFSP.writeFile(NodePath.join(workspace, "AGENTS.md"), "workspace-context-loads");
    await NodeFSP.writeFile(
      NodePath.join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: { ambient: { type: "stdio", command: "touch", args: [hook] } },
      }),
    );
    await NodeFSP.writeFile(NodePath.join(h.dataRoot, "adhd.md"), "data-root-adhd-marker");
    const prompt = (
      await NodeFSP.readFile(NodePath.join(h.dataRoot, "system.md"), "utf8")
    ).replaceAll("{{ADHD}}", "data-root-adhd-marker");
    await h.ozi("say", "real-bridge-loadout");
    const result = await h.wait("ozi-main", "text:bridge-ok", 60);
    expect(result.thread.effectiveLoadout).toMatchObject({
      provider: "pi",
      model: "claude-bridge/claude-opus-5-5",
      options: [
        { id: "thinking", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
    const names = result.thread.effectiveLoadout?.toolNames ?? [];
    expect(names.slice(0, PI_BUILTIN_TOOL_NAMES.length)).toEqual([...PI_BUILTIN_TOOL_NAMES]);
    expect(names).toEqual(expect.arrayContaining(["delegate_task", "html_render", "preview_open"]));
    const requests = fake.requests.filter((request) =>
      request.system?.some((block) => block.text.includes("data-root-adhd-marker")),
    );
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request.model).toBe("claude-opus-5-5");
      expect(request.output_config?.effort).toBe("high");
      expect(request.speed).not.toBe("fast");
      expect(request.system.map((block) => block.text).join("\n")).toContain(prompt);
      expect(JSON.stringify(request)).not.toMatch(
        /ambient-context-must-not-load|ambient-skill-must-not-load/,
      );
      expect(request.tools.map((tool) => tool.name).sort()).toEqual(
        names
          .map((name, index) =>
            index < PI_BUILTIN_TOOL_NAMES.length
              ? `mcp__custom-tools__${name}`
              : `mcp__custom-tools__mcp__t3-code__${name}`,
          )
          .sort(),
      );
    }
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("ozi-demo-skill-loaded");
    expect(JSON.stringify(requests.at(-1))).toContain("workspace-context-loads");
    await expect(NodeFSP.stat(hook)).rejects.toThrow();
  } finally {
    await h.close();
    await fake.close();
  }
});
