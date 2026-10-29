import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const write = (file, content) => {
  const temporary = `${file}.ozi-${process.pid}`;
  NodeFS.writeFileSync(temporary, content);
  NodeFS.renameSync(temporary, file);
};

const file = NodeModule.createRequire(import.meta.url).resolve("pi-claude-bridge/src/index.ts");
const original = NodeFS.readFileSync(file, "utf8");
let patched = original;
for (const [before, after] of [
  [
    "\t\tenv: childEnv,\n\t\ttools: [],",
    "\t\tenv: childEnv,\n\t\tsettingSources: [],\n\t\tstrictMcpConfig: true,\n\t\ttools: [],",
  ],
  [
    "\tconst config = loadConfig(process.cwd());",
    '\tconst config = loadConfig(process.cwd());\n\tconfig.askClaude = { enabled: false };\n\tconfig.provider = { ...config.provider, strictMcpConfig: true, autoMemoryEnabled: false, pathToClaudeCodeExecutable: "claude" };',
  ],
  [
    '\tpi.on("before_agent_start", (event) => {\n\t\tlastSystemPromptOptions = event.systemPromptOptions;',
    '\tlet oziSystemPrompt: string | undefined;\n\tpi.on("before_agent_start", (event, ctx) => {\n\t\tif (oziSystemPrompt !== undefined && oziSystemPrompt !== event.systemPrompt)\n\t\t\tmarkRebuildForSession(ctx.sessionManager.getSessionId(), "ozi-prompt-change");\n\t\toziSystemPrompt = event.systemPrompt;\n\t\tlastSystemPromptOptions = event.systemPromptOptions;',
  ],
]) {
  if (patched.includes(after)) continue;
  if (!patched.includes(before)) throw new Error("Unsupported pi-claude-bridge source");
  patched = patched.replace(before, after);
}
if (patched !== original) write(file, patched);
const sessions = NodeURL.fileURLToPath(import.meta.resolve("cc-session-io"));
const manifest = NodePath.resolve(NodePath.dirname(sessions), "../package.json");
const pkg = JSON.parse(NodeFS.readFileSync(manifest, "utf8"));
if (!pkg.exports["."].default) {
  pkg.exports["."].default = pkg.exports["."].import;
  write(manifest, JSON.stringify(pkg, null, 2));
}
