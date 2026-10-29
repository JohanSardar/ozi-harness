import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import type { OziCheck, OziJobCard, ScheduledTask } from "@t3tools/contracts";
import { afterEach, expect, it } from "vite-plus/test";
import { startHarness, type Harness, type Rule } from "./harness.ts";

type Card = typeof OziJobCard.Encoded;
let h: Harness;
afterEach(async () => {
  await h?.close();
});

it("m7.cli-text", async () => {
  h = await startHarness();
  const text = async (...args: string[]) => {
    const result = await h.execOutput(...args);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout.length).toBeLessThan(6000);
    return result.stdout;
  };
  const line = async (...args: string[]) => {
    const output = await text(...args);
    expect(output.trim().split("\n")).toHaveLength(1);
    return output;
  };
  const ambiguous = async (...args: string[]) => {
    const result = await h.execOutput(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/ambiguous/i);
  };
  const delegate = (task: string): Rule["steps"][number] => ({
    tool: {
      name: "delegate_task",
      arguments: { task, title: task, mode: "async", clientRequestId: task },
    },
  });
  await h.script([
    {
      match: "^text-start$",
      role: "main",
      steps: [delegate("text-first"), delegate("text-second"), { say: "Text workers started" }],
    },
    {
      match: "^text-(first|second)$",
      role: "worker",
      steps: [{ ask: "Which color?" }, { say: "Color selected: $result" }],
      repeat: true,
    },
    { match: ".*", role: "main", steps: [{ say: "Received" }], repeat: true },
  ]);
  await line("say", "text-start");
  await h.wait("ozi-main", "text:Text workers started", 30);
  const cards = await h.ozi<Card[]>("jobs");
  expect(cards).toHaveLength(2);
  for (const card of cards) await h.ozi("wait", "job", card.jobId, "needs_you", "--timeout", "30");
  const pending = await h.ozi<Card[]>("jobs");
  const first = pending.find((card) => card.title === "text-first")!;
  const second = pending.find((card) => card.title === "text-second")!;
  const listing = await text("jobs");
  expect(listing).toMatch(/Needs you \(2\)[\s\S]*Running \(0\)[\s\S]*Ready \(0\)[\s\S]*Done \(0\)/);
  for (const card of pending) {
    expect(listing).toContain(card.jobId.slice(-8));
    expect(listing).not.toContain(card.jobId);
    expect(listing).toContain(card.eventId.slice(-8));
    expect(listing).toContain(card.requests[0]!.id.slice(-8));
    expect(listing).toContain("question");
    expect(listing).toContain("Which color?");
    expect(listing).toContain("Yes");
  }
  await ambiguous("job", "-");
  await ambiguous("close", "-", first.eventId);
  await ambiguous("answer", "-", "Blue");
  expect(await text("job", first.jobId.slice(-24, -1))).toContain("text-first");
  expect(await h.ozi("job", first.jobId.slice(-8))).toHaveProperty("lead");
  await line("answer", first.requests[0]!.id.slice(-8), "Blue");
  const ready = await h.ozi<Card>("wait", "job", first.jobId, "ready", "--timeout", "40");
  const detail = await text("job", first.jobId.slice(-8));
  expect(detail).toContain("Color selected:");
  expect(detail).toContain("you: text-first");
  expect(detail).toContain("ozi: Color selected:");
  const transcript = await text("thread", first.jobId.slice(-24, -1));
  expect(transcript).toContain("completed");
  expect(transcript).toContain("you: text-first");
  expect(transcript).toContain("ozi: Color selected:");
  expect(transcript).not.toContain("providerSessions");
  const stale = await h.execOutput("close", first.jobId.slice(-8), first.eventId);
  expect(stale).toEqual({ code: 1, stdout: "", stderr: "The job has a newer event.\n" });
  expect(await h.execOutput("close", first.jobId.slice(-8), first.eventId, "--json")).toEqual({
    code: 1,
    stdout: '{"error":{"code":"StaleEvent","message":"The job has a newer event."}}\n',
    stderr: "",
  });
  expect((await h.ozi<Card[]>("jobs")).find((card) => card.jobId === first.jobId)?.column).toBe(
    "ready",
  );
  await line("close", first.jobId.slice(-8), ready.eventId.slice(-8));
  await h.ozi("wait", "job", first.jobId, "done");
  await line("stop", "--thread", second.jobId.slice(-8));
  const stopped = await h.ozi<Card>("wait", "job", second.jobId, "needs_you");
  await line("close", second.jobId.slice(-8), stopped.eventId.slice(-8));
  await line("wait", "job", first.jobId.slice(-8), "done");
  const checks = await h.ozi<(typeof OziCheck.Encoded)[]>("checks", first.jobId.slice(-8));
  expect(checks.length).toBeGreaterThan(0);
  expect(await text("checks", first.jobId.slice(-8))).toContain(checks[0]!.id.slice(-8));
  const checkSubstring = checks[0]!.id.slice(1, -1);
  expect(
    (await h.ozi<(typeof OziCheck.Encoded)[]>("checks")).filter((check) =>
      check.id.includes(checkSubstring),
    ),
  ).toHaveLength(1);
  await line("wait", "check", checkSubstring, checks[0]!.state);
  const status = await text("status");
  expect(status).toContain("connected");
  expect(status).toContain("claude-bridge/claude-opus-5-5");
  expect(status).toContain("high");
  expect(status).toContain("fastMode=false");
  for (const provider of ["pi", "codex", "claudeAgent"]) expect(status).toContain(provider);
  expect(status).not.toContain("systemPromptSha256");
  for (const command of ["mistakes", "replays", "fixes", "schedules", "todos"]) await text(command);
  await line("service", "status");
  const schedule = await h.ozi<typeof ScheduledTask.Encoded>(
    "schedule",
    "add",
    "--every",
    "1d",
    "--prompt",
    "text-schedule",
  );
  const scheduleText = await text("schedules");
  expect(scheduleText).toContain(schedule.id.slice(-8));
  expect(scheduleText).toContain("every 1d");
  await line("schedule", "run", schedule.id.slice(-8));
  await line("schedule", "rm", schedule.id.slice(-8));
  await line("schedule", "add", "--every", "1d", "--prompt", "text-other-schedule");
  const state = `${h.root}/todos.json`;
  await NodeFSP.writeFile(
    state,
    JSON.stringify({
      items: [
        { key: "first-a12345678", name: "First task", url: null, state: "open" },
        { key: "second-b12345678", name: "Second task", url: null, state: "done" },
      ],
    }),
  );
  await h.ozi(
    "todos",
    "--configure",
    JSON.stringify({
      source: "Tasks",
      server: {
        type: "stdio",
        command: process.execPath,
        args: [NodeURL.fileURLToPath(new URL("./fixtures/todos.mjs", import.meta.url)), state],
      },
      tool: "list_reminders",
      arguments: { list: "inbox" },
      itemsPath: "reminders",
      fields: { id: "key", title: "name", link: "url", status: "state" },
    }),
  );
  const todos = await text("todos");
  expect(todos).toContain("a12345678 open First task");
  expect(todos).toContain("b12345678 done Second task");
  expect(todos).not.toContain("first-a12345678");
  const json = await h.execOutput("jobs", "--json");
  expect(json.stdout).toBe(`${JSON.stringify(await h.ozi("jobs"))}\n`);
  const unknown = await h.execOutput("job", "missing-job");
  expect(unknown).toEqual({ code: 1, stdout: "", stderr: "Ozi found no such job.\n" });
  const main = await h.thread("ozi-main");
  const events = await h.ozi<{ event: { id: string; type: string; payload: { text?: string } } }[]>(
    "events",
    "ozi-main",
  );
  const source = events.find(
    (item) =>
      item.event.type === "message.updated" && item.event.payload.text === "Text workers started",
  )!;
  await h.script([
    {
      match: "^text-correction$",
      role: "main",
      steps: [
        {
          tool: {
            name: "log_mistake",
            arguments: {
              sourceEventId: source.event.id,
              beforeUserMessageId: main.messages.find((message) => message.text === "text-start")!
                .id,
              correctionMessageId: "$messageId",
              fingerprint: "cli-text-repair",
              what: "Wrong output",
              why: "unknown",
            },
          },
        },
        { say: "Text correction logged" },
      ],
    },
    {
      match: "OZI_REPAIR_AUTHOR",
      stage: "author",
      steps: [{ exec: "printf 'Updated prompt\\n' > /data/system.md" }],
    },
    { match: "text-start", stage: "baseline", steps: [{ say: "Text workers started" }] },
    { match: "text-start", stage: "candidate", steps: [{ say: "Corrected output" }] },
    {
      match: "OZI_REPAIR_OBSERVER",
      stage: "observer",
      steps: [
        {
          say: JSON.stringify({
            baselineReproduced: true,
            candidatePassed: true,
            agrees: true,
            evidence: "Output corrected",
          }),
        },
      ],
    },
  ]);
  await line("say", "text-correction");
  await h.wait("ozi-main", "text:Text correction logged", 30);
  const [mistake] = await h.ozi<{ id: string }[]>("mistakes");
  await line("wait", "mistake", mistake!.id.slice(1, -1), "shipped", "--timeout", "90");
  expect(await text("mistakes")).toContain(`${mistake!.id.slice(-8)} shipped Wrong output`);
  expect(await line("mistake", mistake!.id.slice(1, -1))).toContain("Wrong output");
  const [replay] = await h.ozi<{ id: string }[]>("replays");
  expect(await text("replays")).toContain(`${replay!.id.slice(-8)} passed`);
  await line("wait", "replay", replay!.id.slice(1, -1), "finished");
  const [fix] = await h.ozi<{ id: string; commit_sha: string }[]>("fixes");
  const fixes = await text("fixes");
  expect(fixes).toContain(`${fix!.id.slice(-8)} shipped commit ${fix!.commit_sha.slice(-8)}`);
  await line("undo", fix!.id.slice(1, -1));
  await line("wait", "fix", fix!.id.slice(1, -1), "undone");
});
