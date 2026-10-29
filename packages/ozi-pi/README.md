# Ozi for Pi

Requires Pi 1.4, Node 24 and `claude` on PATH, signed in with a Claude subscription (`claude auth login`). No Anthropic API key is used.

From this checkout, run:

```sh
OZI_DATA_ROOT=/absolute/data-root pi -e ./packages/ozi-pi
```

Or install once with `pi install ./packages/ozi-pi`, then run `OZI_DATA_ROOT=/absolute/data-root pi`. Run `pnpm install` first in a checkout. The package also installs independently with npm; its bridge adapter applies Ozi's isolation patch and adds the session reader export needed by Pi's bundled loader. These idempotent changes affect only installed dependencies, without changing Pi configuration files. Prompt edits rebuild the bridge mirror while preserving Pi history.

`--ozi-data-root /absolute/data-root` overrides `OZI_DATA_ROOT`; the default is `~/ozi`. The package only reads this root. Supply an existing `system.md` and optional `adhd.md` and `skills/`; it does not seed or migrate data. A new root can start with `apps/server/src/ozi/defaults/system.md`.

Every submitted turn rereads `system.md`, replacing every `{{ADHD}}` with `adhd.md` or an empty string. It replaces Pi's default prompt prefix, preserving Pi's context files and appended instructions. Pi discovers data-root skills at startup and `/reload`; its `read` tool loads their contents on demand.

Sessions start on `claude-bridge/claude-opus-5-5`, high thinking, fast off. The pinned `pi-claude-bridge@0.9.3` uses the Claude Agent SDK with no Claude settings sources or built-in tools. AskClaude is disabled, MCP is strict, auto memory is off. Anthropic API key and alternate-cloud environment settings are removed from the Pi process.

Delegation stays in the data-root prompt: Ozi delegates work, stays responsive and defaults to Codex gpt-6.1-sol, xhigh, Fast. Connect the GUI's tools through Pi's own MCP configuration (`pi mcp add …`); the package does not start a server or invent a worker transport. GUI wiring, self-repair, completion checks and inbox hooks are separate tickets. The current server keeps its existing launch path.

Verify without a build:

```sh
vp test run --root e2e --config h2.config.ts h2.pi.test.ts
vp run --filter @ozi/pi typecheck
vp lint packages/ozi-pi e2e/h2.pi.test.ts e2e/h2.config.ts
node scripts/features.ts check h2
```
