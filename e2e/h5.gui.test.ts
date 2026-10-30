import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium } from "playwright";
import { expect, it } from "vite-plus/test";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
async function freePort() {
  const server = NodeNet.createServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as NodeNet.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const milestone = process.env.OZI_H7_GUI_ROOT ? "h7" : "h5";
it.skipIf(!process.env[`OZI_${milestone.toUpperCase()}_GUI_ROOT`])(
  `${milestone}.gui real subscription checks a worker before Review in the dev inbox`,
  async () => {
    const gui = NodePath.resolve(process.env[`OZI_${milestone.toUpperCase()}_GUI_ROOT`]!);
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ozi-h5-gui-"));
    const home = NodePath.join(directory, "home");
    const data = NodePath.join(directory, "data");
    const workspace = NodePath.join(directory, "work");
    const pkg = NodePath.resolve(import.meta.dirname, "../packages/ozi-pi");
    const bin = NodePath.join(gui, "apps/server/src/bin.ts");
    const serverPort = await freePort();
    const webPort = await freePort();
    await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
    await NodeFSP.mkdir(data);
    await NodeFSP.mkdir(workspace);
    await NodeFSP.writeFile(
      NodePath.join(data, "system.md"),
      "You are Ozi. Coordinate workers. Check their evidence before Review using completion_check. Use the GUI's ticket tools for user attention.",
    );
    await NodeFSP.writeFile(
      NodePath.join(home, "userdata/settings.json"),
      JSON.stringify({
        enableProviderUpdateChecks: false,
        defaultRuntimeMode: "full-access",
        defaultModelSelection: { instanceId: "ozi", model: "claude-bridge/claude-opus-5-5" },
        providerInstances: {
          ozi: {
            driver: "pi",
            enabled: true,
            config: {
              harness: "pi",
              binaryPath: NodePath.resolve(import.meta.dirname, "node_modules/.bin/pi"),
              launchArgs: `--extension ${JSON.stringify(pkg)} --ozi-data-root ${JSON.stringify(data)}`,
              customModels: ["claude-bridge/claude-opus-5-5"],
            },
          },
          codex: { driver: "codex", enabled: false },
          claudeAgent: { driver: "claudeAgent", enabled: false },
        },
      }),
    );
    await exec("git", ["init", "--quiet"], { cwd: workspace });
    await NodeFSP.writeFile(NodePath.join(workspace, "answer.txt"), "old\n");
    await exec("git", ["add", "answer.txt"], { cwd: workspace });
    await exec(
      "git",
      [
        "-c",
        "user.name=Ozi",
        "-c",
        "user.email=ozi@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ],
      { cwd: workspace },
    );
    const env = {
      ...process.env,
      HOME: directory,
      OZI_HOME: "",
      OZI_TELEMETRY_ENABLED: "false",
      OZI_PORT: String(serverPort),
      OZI_SINGLE_ORIGIN_DEV: "1",
      PORT: String(webPort),
      CLAUDE_CONFIG_DIR: NodePath.join(directory, "claude"),
      PI_CODING_AGENT_DIR: NodePath.join(directory, "pi"),
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    };
    const children: NodeChildProcess.ChildProcess[] = [];
    let output = "";
    const start = async (command: string, args: string[], cwd: string, ready: RegExp) => {
      const child = NodeChildProcess.spawn(command, args, { cwd, env, stdio: "pipe" });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        const read = (chunk: Buffer) => {
          output += chunk;
          if (ready.test(output)) resolve();
        };
        child.stdout!.on("data", read);
        child.stderr!.on("data", read);
        child.once("exit", (code) =>
          reject(new Error(`Dev process exited ${code}: ${output.slice(-2000)}`)),
        );
      });
    };
    const ozi = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [bin, ...args, "--home", home, "--json"], {
            cwd: workspace,
            env,
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
          })
        ).stdout,
      );
    const browser = await chromium.launch();
    try {
      await start(
        process.execPath,
        [
          bin,
          "serve",
          "--port",
          String(serverPort),
          "--host",
          "127.0.0.1",
          "--home",
          home,
          "--dev-url",
          `http://localhost:${webPort}`,
          "--no-browser",
        ],
        workspace,
        /Ozi server is ready\./,
      );
      await start(
        NodePath.join(gui, "node_modules/.bin/vp"),
        ["dev", "--strictPort"],
        NodePath.join(gui, "apps/web"),
        /ready in/,
      );
      const worker =
        milestone === "h5"
          ? await ozi(
              "thread",
              "start",
              "--cwd",
              workspace,
              'Write the literal text "42 exactly" followed by a newline into answer.txt. Save git diff -- answer.txt into diff.txt. No tests or PR are requested. Do not file a ticket. Report the two file paths when done.',
              "--wait",
            )
          : null;
      const main = await ozi(
        "thread",
        "start",
        "--cwd",
        workspace,
        "Wait for my instruction.",
        "--wait",
      );
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(20000);
      await page.addInitScript(() =>
        localStorage.setItem(
          "ozi:client-settings:v1",
          JSON.stringify({ onboardingCompletedAt: "2026-01-01T00:00:00.000Z" }),
        ),
      );
      await page.goto((await ozi("pair")).pairingUrl);
      await page.locator('[contenteditable="true"]').first().waitFor();
      const threads = await ozi("thread", "list");
      const link = new URL(
        threads.find((thread: { threadId: string }) => thread.threadId === main.threadId).link,
      );
      link.host = `localhost:${webPort}`;
      await page.goto(link.href);
      const composer = page.locator('[contenteditable="true"]').first();
      await composer.fill(
        milestone === "h7"
          ? 'Check capabilities, then delegate exactly one Ozi worker on claude-bridge/claude-opus-5-5 in wait mode. Its task: write the literal line "42 exactly" into answer.txt and save git diff -- answer.txt into diff.txt. No tests or PR requested. After the worker finishes, inspect both files and use completion_check with workerId set to the taskId (not childThreadId) returned by delegate_task, files ["answer.txt","diff.txt"], and a Review ticket titled "H7 verified worker result". The check resolves the task ID. Do not file Review directly. Stop after the check succeeds.'
          : `Check worker ${worker!.threadId}'s completed job: answer.txt must contain the literal line "42 exactly". Read answer.txt and diff.txt. No tests or PR were requested. Use completion_check with workerId ${worker!.threadId}, files ["answer.txt","diff.txt"] and a Review ticket titled "H5 verified worker result". File it through the check and stop.`,
      );
      await composer.press("Enter");
      const inbox = page.getByRole("complementary", { name: "Inbox" });
      await inbox
        .getByRole("button", {
          name: new RegExp(`${milestone.toUpperCase()} verified worker result`),
        })
        .waitFor({ timeout: 120000 });
      const result = await ozi(
        "ticket",
        "list",
        "--input",
        JSON.stringify({ search: `${milestone.toUpperCase()} verified worker result` }),
      );
      const ticket =
        result.tickets.find((ticket: { group: string }) => ticket.group === "Review") ??
        result.tickets[0];
      expect(ticket.group, JSON.stringify(ticket)).toBe("Review");
      expect(ticket.markdown).toContain("Verified by completion check");
      expect(ticket.origin.threadId).toBe(main.threadId);
      if (!(await inbox.getByRole("button", { name: "Open details" }).isVisible()))
        await inbox
          .getByRole("button", {
            name: new RegExp(`${milestone.toUpperCase()} verified worker result`),
          })
          .click();
      await inbox.getByRole("button", { name: "Open details" }).click();
      await page
        .getByRole("dialog")
        .getByText(/Verified by completion check/)
        .waitFor();
      await page.screenshot({
        path:
          process.env[`OZI_${milestone.toUpperCase()}_SCREENSHOT`] ??
          NodePath.join(NodeOS.tmpdir(), "ozi-h5-review.png"),
      });
      const checks = JSON.parse(
        (
          await exec(
            process.execPath,
            [NodePath.join(pkg, "src/cli.mjs"), "checks", "--data-root", data, "--json"],
            { env },
          )
        ).stdout,
      );
      const checked = checks.findLast((row: { workerId: string | null }) => row.workerId !== null);
      expect(checked.state).toBe("checked");
      const history = await ozi("thread", "show", main.threadId, "--activity");
      if (milestone === "h7") {
        expect(JSON.stringify(history)).toContain("task_status");
        expect(JSON.stringify(history)).not.toContain("thread_not_found");
      }
      process.stdout.write(
        JSON.stringify({
          ticket: { group: ticket.group, markdown: ticket.markdown },
          check: { state: checked.state, workerId: checked.workerId, verified: checked.verified },
        }) + "\n",
      );
    } finally {
      await browser.close();
      for (const child of children.toReversed()) {
        if (child.exitCode === null) {
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGTERM");
          await exited;
        }
      }
      await NodeFSP.rm(directory, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
