import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function ozi(pi: ExtensionAPI) {
  pi.registerFlag("ozi-data-root", { type: "string", description: "Ozi data root" });
  const dataRoot = () => {
    const root =
      pi.getFlag("ozi-data-root") ||
      process.env.OZI_DATA_ROOT ||
      NodePath.join(NodeOS.homedir(), "ozi");
    if (typeof root !== "string" || !NodePath.isAbsolute(root))
      throw new Error("Ozi data root must be an absolute path");
    return NodePath.resolve(root);
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.CLAUDE_CODE_USE_VERTEX;
  delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  process.env.CLAUDE_CODE_DISABLE_FAST_MODE = "1";
  process.env.ENABLE_TOOL_SEARCH = "false";

  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.modelRegistry.find("claude-bridge", "claude-opus-5-5");
    if (!model || !(await pi.setModel(model)))
      throw new Error("Ozi requires claude-bridge/claude-opus-5-5");
    pi.setThinkingLevel("high");
  });
  pi.on("resources_discover", () => ({ skillPaths: [NodePath.join(dataRoot(), "skills")] }));
  pi.on("before_agent_start", (event, ctx) => {
    try {
      if (ctx.model?.provider !== "claude-bridge")
        throw new Error("Ozi requires the Claude subscription bridge");
      const root = dataRoot();
      const system = NodeFS.readFileSync(NodePath.join(root, "system.md"), "utf8");
      let adhd = "";
      try {
        adhd = NodeFS.readFileSync(NodePath.join(root, "adhd.md"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      event.systemPromptOptions.customPrompt = system.replaceAll("{{ADHD}}", adhd);
    } catch (error) {
      ctx.abort();
      throw error;
    }
  });
}
