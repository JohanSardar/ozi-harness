import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { startHarness } from "./harness.ts";
import { startAnthropic } from "./fakes/anthropic.ts";

it("m5.correction-repairs real Pi and Claude Code replay main through the confined inference proxy", async () => {
  const pi = await NodeFSP.realpath(
    NodeURL.fileURLToPath(
      new URL("./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url),
    ),
  );
  const claude = NodeURL.fileURLToPath(new URL("./node_modules/.bin", import.meta.url));
  const token = "sk-ant-oat01-ozi-test-subscription";
  const fixed = "For math questions answer only the number followed by exactly.\n";
  let sourceEventId = "";
  let beforeUserMessageId = "";
  let correctionMessageId = "";
  const fake = await startAnthropic((input) => {
    const system = input.system.map((block) => block.text).join("\n");
    const messages = JSON.stringify(input.messages);
    const tools = input.tools ?? [];
    if (system.includes("Independently judge the frozen case"))
      return {
        text: JSON.stringify({
          baselineReproduced: true,
          candidatePassed: true,
          agrees: true,
          evidence: "Baseline returned 42; candidate returned 42 exactly.",
        }),
      };
    if (system.includes("Repair only the candidate data root")) {
      if (messages.includes('"tool_result"')) return { text: "authored" };
      const write = tools.find((tool) => /(?:__|^)write$/.test(tool.name));
      if (!write) throw new Error(`Missing author write: ${JSON.stringify(tools)}`);
      return { tool: write.name, arguments: { path: "/data/system.md", content: fixed } };
    }
    if (system.includes("runtime completion checker"))
      return { text: '{"verdict":"done","useful":false}' };
    if (messages.includes("Please fix this")) {
      if (messages.includes('"tool_result"')) return { text: "Logged it." };
      correctionMessageId =
        messages
          .match(/\[Ozi message ID: ([^\]]+)\]/g)
          ?.at(-1)
          ?.slice(17, -1) ?? "";
      const log = tools.find((tool) => tool.name.endsWith("__log_mistake"));
      if (!log) throw new Error("Missing log_mistake");
      return {
        tool: log.name,
        arguments: {
          sourceEventId,
          beforeUserMessageId,
          correctionMessageId,
          fingerprint: "math-answer-format-missing-exactly",
          what: "Math answer omitted exactly",
          why: "No formatting rule",
        },
      };
    }
    return { text: system.includes(fixed.trim()) ? "42 exactly" : "42" };
  });
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
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    },
  }).catch(async (error: unknown) => {
    await fake.close();
    throw error;
  });
  try {
    await h.ozi("wait", "provider", "pi", "ready", "--timeout", "30");
    await h.ozi("say", "What is 6 times 7?");
    await h.wait("ozi-main", "text:42", 60);
    await h.wait("ozi-main", "completed", 60);
    const events = await h.ozi<
      Array<{ event: { id: string; type: string; payload: { id: string; role?: string } } }>
    >("events", "ozi-main");
    sourceEventId = events.findLast(
      (value) => value.event.type === "message.updated" && value.event.payload.role === "assistant",
    )!.event.id;
    beforeUserMessageId = events.findLast(
      (value) => value.event.type === "message.updated" && value.event.payload.role === "user",
    )!.event.payload.id;
    await h.ozi(
      "say",
      "For math questions I always want just the number followed by the word exactly, like: 42 exactly. Please fix this so it doesn't happen again.",
    );
    await h.wait("ozi-main", "text:Logged it.", 60);
    const row = (
      await h.ozi<Array<{ id: string; boundary: string; trigger_event_id: string }>>("mistakes")
    )[0]!;
    expect(row).toBeDefined();
    expect(row.boundary).toBe(beforeUserMessageId);
    expect(correctionMessageId).not.toBe("");
    const replay = await h.ozi<{ state: string; reason: string; evidence_json: string }>(
      "wait",
      "replay",
      row.id,
      "finished",
      "--timeout",
      "120",
    );
    expect(replay.state, replay.evidence_json).toBe("passed");
    const evidence = JSON.parse(replay.evidence_json);
    for (const stage of ["baseline", "candidate"]) {
      expect(evidence[stage].command).toContain("--unshare-all");
      expect(evidence[stage].command).toContain("/inference.sock");
      expect(evidence[stage].evidence.nativeFork).toBe(true);
      expect(evidence[stage].evidence.unknown).toEqual([]);
    }
    expect(evidence.baseline.evidence.transcript).toEqual(["42"]);
    expect(evidence.candidate.evidence.transcript).toEqual(["42 exactly"]);
    expect(JSON.stringify(evidence)).not.toContain(token);
    const proxied = fake.headers.filter((headers) => headers["x-app"] === "cli");
    expect(proxied.length).toBeGreaterThanOrEqual(4);
    expect(proxied.every((headers) => headers.authorization === `Bearer ${token}`)).toBe(true);
    expect(proxied.every((headers) => headers["x-api-key"] === undefined)).toBe(true);
  } finally {
    await h.close();
    await fake.close();
  }
});
