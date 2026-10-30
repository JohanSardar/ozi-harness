# Ozi for Pi

Requires Pi 1.4, Node 24 and `claude` on PATH, signed in with a Claude subscription (`claude auth login`). No Anthropic API key is used.

From this checkout, run:

```sh
OZI_DATA_ROOT=/absolute/data-root pi -e ./packages/ozi-pi
```

Or install once with `pi install ./packages/ozi-pi`, then run `OZI_DATA_ROOT=/absolute/data-root pi`. Run `pnpm install` first in a checkout. The package also installs independently with npm; its bridge adapter applies Ozi's isolation patch and adds the session reader export needed by Pi's bundled loader. These idempotent changes affect only installed dependencies, without changing Pi configuration files. Prompt edits rebuild the bridge mirror while preserving Pi history.

`--ozi-data-root /absolute/data-root` overrides `OZI_DATA_ROOT`; the default is `~/ozi`. Supply an existing `system.md` and optional `adhd.md` and `skills/`; repair initializes a missing git repository with one local commit. Existing files stay intact. A new root can start with `apps/server/src/ozi/defaults/system.md`.

Every submitted turn rereads `system.md`, replacing every `{{ADHD}}` with `adhd.md` or an empty string. It replaces Pi's default prompt prefix, preserving Pi's context files and appended instructions. Pi discovers data-root skills at startup and `/reload`; its `read` tool loads their contents on demand.

Sessions start on `claude-bridge/claude-opus-5-5`, high thinking, fast off. The pinned `pi-claude-bridge@0.9.3` uses the Claude Agent SDK with no Claude settings sources or built-in tools. AskClaude is disabled, MCP is strict, auto memory is off. Anthropic API key and alternate-cloud environment settings are removed from the Pi process.

Delegation stays in the data-root prompt: Ozi delegates work, stays responsive and defaults to Codex gpt-6.1-sol, xhigh, Fast. Connect the GUI's tools through Pi's own MCP configuration (`pi mcp add …`); the package does not start a server or invent a worker transport. The GUI supplies delegation and ticket tools. The current server keeps its existing launch path.

The package bundles the standalone [P3 Pi inbox extension](https://github.com/JohanSardar/ozi/pull/14) unchanged in `src/inbox.ts`. With the GUI's `OZI_MCP_URL` and four ticket tools connected, each settled top-level turn starts an isolated native `--fork` check on the current model and thinking level. It files tickets for results or anything needing the user's answer or acknowledgement, closes acknowledged tickets and skips small talk. Source history stays untouched. Pi status events report the filed count or failure. The GUI may inject its copy too: the shared event-bus guard installs the hook once in either order. Forks set `OZI_INBOX_FORK=1`, retain their model and thinking and never run another inbox check. The GUI derives `OZI_SUBAGENT=1` from the thread parent relationship. Subagents receive neither the inbox hook nor Ozi main's inbox/delegation prompting; ticket tools remain available for explicitly assigned filing. Main must explicitly assign worker ticket filing or file from the result itself. Completion checks remain unchanged. Without the GUI connection the hook is inactive.

The GUI may also supply `OZI_PI_INBOX_CONTEXT_FILE` with the source run ID; P3 captures it for the fork as `OZI_INBOX_RUN_ID`. The connected MCP transport remains responsible for forwarding this provenance to the GUI.

Verify without a build:

```sh
vp test run --root e2e --config h2.config.ts h2.pi.test.ts
vp run --filter @ozi/pi typecheck
vp lint packages/ozi-pi e2e/h2.pi.test.ts e2e/h2.config.ts
node scripts/features.ts check h2
```

```sh
vp test run --root e2e --config h2.config.ts h3.pi-inbox.test.ts
OZI_H3_REAL=1 vp test run --root e2e --config h2.config.ts h3.pi-inbox.test.ts
node scripts/features.ts check h3
```

Self-repair requires Linux and bubblewrap (`bwrap`); logging remains available elsewhere and replay fails closed. `repair_context` supplies native IDs for `log_mistake`. A later direct user correction or repeated fingerprint triggers serial confined authoring, baseline/candidate forks and an independent observer. Only prompt, ADHD and skill changes can publish; protected files stay read-only. Each approved fix activates one local data-root commit. Recurrence undoes it. Nothing pushes.

State lives beside the root in `.<root-name>-harness/`. Inspect and undo from any host running the package:

```sh
ozi-harness mistakes --data-root /absolute/data-root --json
ozi-harness replays --data-root /absolute/data-root --json
ozi-harness fixes --data-root /absolute/data-root --json
ozi-harness undo FIX_ID --data-root /absolute/data-root --json
ozi-harness wait replay REPLAY_ID finished --timeout 120 --data-root /absolute/data-root --json
```

`fixes` exposes activation checkpoints, predecessor and conflict state. `blockers` exposes undo conflicts and the preserved user-build ref. Pi shows these blockers without starting a model turn. Startup recovers journaled activation before prompt reads; interrupted replays fail with their stage evidence. `sessions` and `events SESSION_ID` expose native IDs; `mistakes log --session SESSION_ID --input JSON` logs through the same authority checks. `worker` drains eligible repairs without the GUI server.

```sh
vp test run --root e2e --config h2.config.ts h4.pi.test.ts
OZI_H4_REAL=1 vp test run --root e2e --config h2.config.ts h4.pi.test.ts
node scripts/features.ts check h4
```

Before filing a worker's finished job as Review, main calls `completion_check` with its `workerId`, workspace evidence `files`, and the proposed Review `ticket` (the GUI's full ticket content). Optional `ticketId` updates an existing ticket. Inspect diffs, test output and exit status, files and PR state first; save output as evidence files when needed. The check reads the worker through the GUI and checks inherited history and file contents in an isolated, tool-free native Pi fork on the same model at low effort. Review includes what was verified. Gaps go back to the worker, decisions become Decide and human actions become Do, and three rounds without file progress become Read failure. Checker and evidence failures also file Read failure. Changed evidence or requests and cancellation invalidate the result. Direct worker Review creation/promotion is blocked. An inbox fork without worker activity can still file its own result; it cannot promote an unchecked worker claim. Include the group explicitly when updating a non-Review ticket.

```sh
ozi-harness checks --data-root /absolute/data-root --json
ozi-harness wait check CHECK_ID checked --data-root /absolute/data-root --json
vp test run --root e2e --config h2.config.ts h5.pi.test.ts
OZI_H5_REAL=1 vp test run --root e2e --config h2.config.ts h5.pi.test.ts
OZI_H5_GUI_ROOT=/absolute/gui-checkout vp test run --root e2e --config h2.config.ts h5.gui.test.ts
node scripts/features.ts check h5
```

Successful settled main replies, including text-only replies, are also checked automatically. Main records use `workerId: null` and their native `reportItemId`. Passing checks are silent; `continue` follows up on the same session and tells main to delegate the gaps. Three rounds without verified file progress stop continuation. Human needs and checker failures surface attention without resuming main. Interactive requests remain available during checking and supersede stale results. Inbox and checker forks never check themselves; passing forks leave main's native history unchanged.
