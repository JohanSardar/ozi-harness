import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

it.skipIf(!process.env.OZI_C6_GUI_ROOT)(
  "h7.request-identity C6 preserves rounds across real GUI worker notifications and resets on progress",
  async () => {
    const gui = NodePath.resolve(process.env.OZI_C6_GUI_ROOT!);
    const result = await exec(
      NodePath.join(gui, "node_modules/.bin/vp"),
      ["test", "run", "--root", "e2e", "c6.completion-identity.test.ts"],
      {
        cwd: gui,
        env: {
          ...process.env,
          OZI_C6_HARNESS_ROOT: NodePath.resolve(import.meta.dirname, "../packages/ozi-pi"),
        },
        timeout: 90_000,
      },
    );
    expect(result.stdout).toContain("1 passed");
  },
);
