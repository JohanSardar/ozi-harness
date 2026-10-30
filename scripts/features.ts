import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { parse } from "yaml";

interface Feature {
  id: string;
  reqs: string[];
  module: string;
  cli: string[];
  milestone: number | "h2" | "h3" | "h4" | "h5" | "h6";
  scenarios: string[];
  status: "planned" | "building" | "passing";
}

const fs = await Effect.runPromise(
  FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
);
const root = new URL("..", import.meta.url).pathname;
const graph = parse(await Effect.runPromise(fs.readFileString(`${root}features.yaml`))) as {
  requirements: Record<string, string>;
  features: Feature[];
};
const spec = await Effect.runPromise(fs.readFileString(`${root}SPEC.md`));
const specScenarios = new Set(
  [...spec.matchAll(/^- `((?:m\d|h[23456])\.[a-z0-9-]+)`/gm)].map((m) => m[1]!),
);
const passed = new Set<string>();
const failed = new Set<string>();
for (const name of await Effect.runPromise(fs.readDirectory(`${root}e2e`)))
  if (/^results.*\.json$/.test(name)) {
    const results = JSON.parse(
      await Effect.runPromise(fs.readFileString(`${root}e2e/${name}`)),
    ) as { testResults: { assertionResults: { title: string; status: string }[] }[] };
    for (const file of results.testResults)
      for (const test of file.assertionResults) {
        if (test.status === "passed") passed.add(test.title.split(" ")[0]!);
        else if (test.status === "failed") failed.add(test.title.split(" ")[0]!);
      }
  }
for (const s of failed) passed.delete(s);

const scenarioState = (s: string) => (passed.has(s) ? "pass" : "todo");

function check(milestone: Feature["milestone"]) {
  const errors: string[] = [];
  const covered = new Set(graph.features.flatMap((f) => f.reqs));
  for (const r of Object.keys(graph.requirements))
    if (!covered.has(r)) errors.push(`requirement ${r} has no feature`);
  const mapped = new Set<string>();
  for (const f of graph.features) {
    for (const r of f.reqs)
      if (!graph.requirements[r]) errors.push(`${f.id}: unknown requirement ${r}`);
    for (const s of f.scenarios) {
      mapped.add(s);
      if (!specScenarios.has(s)) errors.push(`${f.id}: scenario ${s} not in SPEC.md`);
      if (
        (typeof milestone === "string"
          ? f.milestone === milestone
          : (typeof f.milestone === "number" && f.milestone <= milestone) ||
            f.status === "passing") &&
        !passed.has(s)
      )
        errors.push(`${f.id}: scenario ${s} not passing`);
    }
  }
  for (const s of specScenarios) if (!mapped.has(s)) errors.push(`scenario ${s} has no feature`);
  for (const e of errors) Effect.runSync(Console.error(e));
  Effect.runSync(
    Console.log(
      `${errors.length === 0 ? "ok" : `${errors.length} problems`} (milestone ${milestone})`,
    ),
  );
  process.exit(errors.length === 0 ? 0 : 1);
}

function html() {
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => `&${({ "&": "amp", "<": "lt", ">": "gt" } as const)[c as "&"]};`);
  const rows = graph.features
    .map(
      (f) =>
        `<tr><td>${typeof f.milestone === "number" ? "M" : ""}${f.milestone}</td><td>${f.id}</td><td>${f.reqs.map((r) => `<span title="${esc(graph.requirements[r] ?? "")}">${r}</span>`).join(" ")}</td><td>${f.module}</td><td>${f.cli.join(" ")}</td><td>${f.scenarios.map((s) => `<span class="${scenarioState(s)}">${s}</span>`).join(" ")}</td><td>${f.status}</td></tr>`,
    )
    .join("\n");
  Effect.runSync(
    Console.log(
      `<!doctype html><meta charset="utf-8"><title>Ozi features</title><style>body{font:13px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px;vertical-align:top}span{display:inline-block;margin:1px;padding:0 4px;border-radius:4px;background:#eee}.pass{background:#cfc}.todo{background:#fdd}</style><h1>Ozi features</h1><p>${passed.size} scenarios passing of ${specScenarios.size}</p><table><tr><th>M</th><th>Feature</th><th>Requirements</th><th>Module</th><th>CLI</th><th>Scenarios</th><th>Status</th></tr>${rows}</table>`,
    ),
  );
}

const [command, arg] = process.argv.slice(2);
if (command === "check")
  check(
    arg === "h2" || arg === "h3" || arg === "h4" || arg === "h5" || arg === "h6"
      ? arg
      : Number(arg ?? 0),
  );
else if (command === "html") html();
else {
  Effect.runSync(
    Console.error("usage: node scripts/features.ts check [milestone|h2|h3|h4|h5|h6] | html"),
  );
  process.exit(2);
}
