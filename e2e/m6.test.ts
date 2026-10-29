import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { afterEach, expect, it } from "vite-plus/test";
import { startHarness, type Harness, type Rule } from "./harness.ts";

type Fix = { id: string; state: string; commit_sha: string; predecessor: string; conflict: number };
type Event = {
  event: { id: string; type: string; payload: { id: string; role?: string } };
};
let h: Harness;
afterEach(async () => {
  await h?.close();
});

const rules: Rule[] = [
  {
    match: "OZI_REPAIR_AUTHOR",
    stage: "author",
    steps: [
      {
        exec: "printf 'Fixed prompt\\n' > /data/system.md; printf 'Fixed skill\\n' > /data/skills/demo/SKILL.md",
      },
    ],
  },
  { match: "frozen request", stage: "baseline", steps: [{ say: "wrong outcome" }] },
  {
    match: "frozen request",
    stage: "candidate",
    steps: [
      { tool: { name: "read_skill", arguments: { name: "demo" } } },
      { say: "expected outcome" },
    ],
  },
  {
    match: "OZI_REPAIR_OBSERVER",
    stage: "observer",
    steps: [
      {
        say: JSON.stringify({
          baselineReproduced: true,
          candidatePassed: true,
          agrees: true,
          evidence: "The same request reproduces before the fix and passes after it.",
        }),
      },
    ],
  },
];

const occurrence = async (text = "frozen request") => {
  await h.script([{ match: text, steps: [{ say: "wrong outcome" }] }]);
  await h.ozi("say", text);
  await h.wait("ozi-main", "completed");
  const events = await h.ozi<Event[]>("events", "ozi-main");
  const input = {
    sourceEventId: events.findLast(
      (e) => e.event.type === "message.updated" && e.event.payload.role === "assistant",
    )!.event.id,
    beforeUserMessageId: events.findLast(
      (e) => e.event.type === "message.updated" && e.event.payload.role === "user",
    )!.event.payload.id,
    fingerprint: "wrong-outcome",
    what: "wrong outcome",
    why: "unknown",
  };
  await h.script([
    {
      match: "record occurrence",
      steps: [{ tool: { name: "log_mistake", arguments: input } }, { say: "recorded" }],
    },
    ...rules,
  ]);
  await h.ozi("say", "record occurrence");
  await h.wait("ozi-main", "completed");
  return (await h.ozi<{ id: string }[]>("mistakes")).at(-1)!.id;
};

const correct = async (id: string) => {
  const row = await h.ozi<{
    source_event_id: string;
    boundary: string;
    fingerprint: string;
    what: string;
    why: string;
  }>("mistake", id);
  const acknowledgement = `received ${id}`;
  await h.script([
    {
      match: "Please use",
      steps: [
        {
          tool: {
            name: "log_mistake",
            arguments: {
              sourceEventId: row.source_event_id,
              beforeUserMessageId: row.boundary,
              correctionMessageId: "$messageId",
              fingerprint: row.fingerprint,
              what: row.what,
              why: row.why,
            },
          },
        },
        { say: acknowledgement },
      ],
    },
    ...rules,
  ]);
  await h.ozi("say", "Please use the requested answer format from now on.");
  await h.wait("ozi-main", `text:${acknowledgement}`, 60);
  await h.wait("ozi-main", "completed", 60);
};

const publish = async () => {
  const id = await occurrence();
  await correct(id);
  await h.ozi("wait", "mistake", id, "shipped");
  return (await h.ozi<Fix[]>("fixes")).find((fix) => fix.id === id)!;
};

const active = async (prompt: string, skill: string) => {
  await h.script([
    {
      match: "inspect active",
      steps: [{ tool: { name: "read_skill", arguments: { name: "demo" } } }, { say: "$result" }],
    },
  ]);
  await h.ozi("say", "inspect active");
  await h.wait("ozi-main", "completed");
  const result = JSON.parse((await h.thread("ozi-main")).messages.at(-1)!.text);
  expect(result.content[0].text).toContain(skill.trim());
  expect((await h.status()).main?.thread.effectiveLoadout?.systemPromptSha256).toBe(
    NodeCrypto.createHash("sha256").update(prompt).digest("hex"),
  );
};

it("m6.publish one local fix commit activates prompt and skills on the next turn and survives restart", async () => {
  h = await startHarness();
  const fix = await publish();
  expect(fix.state).toBe("shipped");
  expect(await h.git("rev-parse", "HEAD")).toBe(fix.commit_sha);
  expect(await h.git("rev-parse", `${fix.commit_sha}^`)).toBe(fix.predecessor);
  expect(
    (await h.git("diff-tree", "--no-commit-id", "--name-only", "-r", fix.commit_sha)).split("\n"),
  ).toEqual(["skills/demo/SKILL.md", "system.md"]);
  expect(await h.git("status", "--porcelain")).toBe("");
  await active("Fixed prompt\n", "Fixed skill");
  await h.restart();
  await active("Fixed prompt\n", "Fixed skill");
  expect(await h.ozi("fixes")).toEqual([fix]);
  expect(await h.ozi("jobs")).toEqual([]);
  await expect(h.ozi("undo", "unknown-fix")).rejects.toThrow();
  expect(await h.git("rev-parse", "HEAD")).toBe(fix.commit_sha);
});

it("m6.recurrence-undo targeted revert preserves later committed and uncommitted edits and manual undo retries", async () => {
  h = await startHarness();
  const original = await NodeFSP.readFile(NodePath.join(h.dataRoot, "system.md"), "utf8");
  const skill = await NodeFSP.readFile(NodePath.join(h.dataRoot, "skills/demo/SKILL.md"), "utf8");
  const fix = await publish();
  const skillPath = NodePath.join(h.dataRoot, "skills/demo/SKILL.md");
  await NodeFSP.unlink(skillPath);
  await NodeFSP.symlink(NodePath.join(h.dataRoot, "protected/rules.md"), skillPath);
  await expect(h.ozi("undo", fix.id)).rejects.toThrow();
  expect(await NodeFSP.readFile(NodePath.join(h.dataRoot, "system.md"), "utf8")).toBe(
    "Fixed prompt\n",
  );
  expect((await h.ozi<Fix[]>("fixes"))[0]?.state).toBe("shipped");
  await NodeFSP.unlink(skillPath);
  await NodeFSP.writeFile(skillPath, "Fixed skill\n");
  await NodeFSP.writeFile(NodePath.join(h.dataRoot, "adhd.md"), "Later user edit\n");
  await h.git("add", "adhd.md");
  await h.git("commit", "-m", "user: add preferences");
  await NodeFSP.writeFile(
    NodePath.join(h.dataRoot, "protected/rules.md"),
    "Later protected rule\n",
  );
  const repeat = await occurrence("recurring frozen request");
  await h.ozi("wait", "mistake", fix.id, "undone");
  expect(await NodeFSP.readFile(NodePath.join(h.dataRoot, "adhd.md"), "utf8")).toBe(
    "Later user edit\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(h.dataRoot, "protected/rules.md"), "utf8")).toBe(
    "Later protected rule\n",
  );
  expect((await h.ozi<{ status: string }>("mistake", repeat)).status).toBe("logged");
  expect(await h.ozi("replays")).toHaveLength(1);
  await active(original.replaceAll("{{ADHD}}", "Later user edit\n"), skill);
  const head = await h.git("rev-parse", "HEAD");
  expect(await h.git("log", "-1", "--format=%B")).toContain(fix.commit_sha);
  await h.ozi("undo", fix.id);
  await h.ozi("undo", fix.id);
  expect(await h.git("rev-parse", "HEAD")).toBe(head);
  await h.restart();
  expect((await h.ozi<Fix[]>("fixes"))[0]?.state).toBe("undone");
});

it("m6.edit-conflict restores the predecessor, preserves the user version and posts one blocker", async () => {
  h = await startHarness();
  const original = await NodeFSP.readFile(NodePath.join(h.dataRoot, "system.md"), "utf8");
  const fix = await publish();
  await NodeFSP.writeFile(
    NodePath.join(h.dataRoot, "system.md"),
    "User rewrote the fixed prompt\n",
  );
  await h.git("add", "system.md");
  await h.git("commit", "-m", "user: rewrite prompt");
  const userHead = await h.git("rev-parse", "HEAD");
  await h.ozi("undo", fix.id);
  expect(await NodeFSP.readFile(NodePath.join(h.dataRoot, "system.md"), "utf8")).toBe(original);
  expect(await h.git("show", `${userHead}:system.md`)).toBe("User rewrote the fixed prompt");
  const fixes = await h.ozi<Fix[]>("fixes");
  expect(fixes[0]).toMatchObject({ state: "undone", conflict: 1 });
  const cards =
    await h.ozi<
      { jobId: string; column: string; status: string; requests: { prompt: string }[] }[]
    >("jobs");
  expect(cards).toHaveLength(1);
  expect(cards[0]?.column).toBe("needs_you");
  expect(cards[0]?.requests[0]?.prompt).toContain(fix.id);
  expect((await h.thread(cards[0]!.jobId)).runs).toEqual([]);
  await h.restart();
  await h.ozi("undo", fix.id);
  expect(await h.ozi("jobs")).toHaveLength(1);
});

it.each([
  ["publish", "prepared"],
  ["publish", "journal"],
  ["publish", "file"],
  ["publish", "head"],
  ["publish", "settled"],
  ["undo", "journal"],
  ["undo", "file"],
  ["undo", "head"],
  ["undo", "settled"],
  ["conflict", "settled"],
] as const)("m6.crash-publish %s:%s recovers one complete build", async (operation, point) => {
  h = await startHarness({
    repairPause: `${operation === "conflict" ? "undo" : operation}:${point}`,
  });
  const original = await NodeFSP.readFile(NodePath.join(h.dataRoot, "system.md"), "utf8");
  const originalSkill = await NodeFSP.readFile(
    NodePath.join(h.dataRoot, "skills/demo/SKILL.md"),
    "utf8",
  );
  let id: string;
  if (operation === "publish") {
    id = await occurrence();
    await correct(id);
  } else {
    id = (await publish()).id;
    if (operation === "conflict") {
      await NodeFSP.writeFile(NodePath.join(h.dataRoot, "system.md"), "Conflicting user edit\n");
      await h.git("add", "system.md");
      await h.git("commit", "-m", "user: edit before undo");
    }
    void h.ozi("undo", id).catch(() => {});
  }
  await h.ozi(
    "wait",
    point === "prepared" ? "replay" : "fix",
    id,
    point === "prepared"
      ? "at:prepared"
      : `at:${operation === "conflict" ? "undo" : operation}:${point}`,
  );
  await h.crash();
  if (point === "prepared") {
    await h.ozi("wait", "mistake", id, "failed");
    expect(await h.ozi("fixes")).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(h.dataRoot, "system.md"), "utf8")).toBe(original);
    expect(await NodeFSP.readFile(NodePath.join(h.dataRoot, "skills/demo/SKILL.md"), "utf8")).toBe(
      originalSkill,
    );
    return;
  }
  await h.ozi("wait", "mistake", id, operation === "publish" ? "shipped" : "undone");
  const fix = (await h.ozi<Fix[]>("fixes"))[0]!;
  expect(fix.state).toBe(operation === "publish" ? "shipped" : "undone");
  if (operation === "conflict") {
    expect(fix.conflict).toBe(1);
    expect(await h.ozi("jobs")).toHaveLength(1);
  }
  expect(await NodeFSP.readFile(NodePath.join(h.dataRoot, "system.md"), "utf8")).toBe(
    operation === "publish" ? "Fixed prompt\n" : original,
  );
  expect(await NodeFSP.readFile(NodePath.join(h.dataRoot, "skills/demo/SKILL.md"), "utf8")).toBe(
    operation === "publish" ? "Fixed skill\n" : originalSkill,
  );
  expect(await h.git("status", "--porcelain")).toBe("");
  await h.ozi("undo", id);
  const head = await h.git("rev-parse", "HEAD");
  await h.restart();
  await h.ozi("undo", id);
  expect(await h.git("rev-parse", "HEAD")).toBe(head);
});
