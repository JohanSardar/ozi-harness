# Ozi spec

Ozi is an agent runtime for anyone. You talk to one main agent; it delegates real work to workers, stays responsive, and keeps every job on a card until it is handled. Forked from T3 Code v0.1.1 (MIT).

## Glossary

- **Main**: the one conversation the user talks to. Pi, Claude Opus 5.5 through the user's Claude subscription, high effort, fast off. Pi's built-in tools plus every Ozi tool workers get; it delegates by behavior, not for lack of tools.
- **Worker**: an agent thread main starts. Default Codex `gpt-6.1-sol`, xhigh, Fast; Claude or Pi when better suited. Pi defaults to `claude-bridge/claude-opus-5-5`; its catalog discovers subscription models, including `claude-bridge/claude-sonnet-5-5`, without a `default` entry. Bridge workers load the same extension and config as main.
- **Job**: one outcome. Its **lead** is the first worker thread for it; job ID = lead thread ID. **Helpers** are descendants that inherit the job ID.
- **Card**: the panel view of a job. Columns: **Needs you > Running > Ready > Done**.
- **Report**: a worker's checked outcome for the job's current request.
- **Claim**: an agent turn that ends saying it is done.
- **Check**: an isolated fork of the claiming thread that returns a **verdict**: `done`, `continue(missing, evidence)` or `needs_user(reason)`, plus a useful-finding flag. One check = one **round**.
- **Blocked**: three consecutive rounds without verified progress.
- **Handle**: close a card against the exact event it showed, with evidence `close`, `accepted(userMessageId)` or `verified(checkEventId)`.
- **Mistake**: one SQLite row: what went wrong and why.
- **Replay**: rerun of the user's message before a mistake, on a branch, with stubbed effects, judged by an **observer**.
- **Fix**: a change to the data root that passed replay; one local git commit. **Undo** reverts it.
- **Protected**: `protected/` in the data root. Repair can't change it; the user can, by asking.
- **Data root**: a git repo (`--data-root`, `OZI_DATA_ROOT`, default `~/ozi`) holding `system.md`, optional `adhd.md`, `skills/`, `protected/`. Startup seeds a missing or empty root from packaged defaults with one initial git commit; existing roots and files stay untouched, except that a legacy `prompt.md` without `system.md` is renamed to `system.md` with one git commit. Live data never belongs in the code repo.
- **Home**: server state directory (default `~/.ozi`), holding SQLite.
- **To-do**: a user task from an external MCP source, shown read-only.

## Modules

New code lives in `apps/server/src/ozi/` and `apps/web/src/components/ozi/`. Everything else is T3, trimmed.

### Jobs (`ozi/Jobs.ts`)

- `cards(mainThreadId) → JobCard[]` via authenticated `ozi.jobs.get` and `ozi.jobs.subscribe` (empty payload, stream of card arrays). `ozi.jobs.handle` returns the existing command receipt sequence.
- Cards expose `jobId`, current `eventId`, title, column, agent, short status, `checking`, `checkState`, `requestEventId`, report, requests with owner thread IDs, `handledEventId`, and `updatedAt`. Secret values never enter cards. Reports contain their checked event ID, text and useful-finding flag.
- `handle({commandId, jobId, eventId, evidence}) → CommandReceipt`. Errors: `UnknownJob`, `WrongJob`, `StaleEvent`, `InvalidEvidence`, no mutation.
- Thread fields only: `jobId`, `visibility`, `handledEventId`. No job tables.
- Column: any unresolved question/approval/secret/login/Blocked in the job → Needs you; else unresolved or unchecked work → Running; checked lead report for current request → Ready; handled → Done. A stopped lead without a newer request shows Needs you, `Stopped`, and `checking: false`. Close hides it; a new request resumes Running. Newer request, actionable event or result reopens.
- Close records `job.handled` against the exact displayed event. Automatic acceptance requires an unambiguous user message after that report; verified handling requires its successful check event. Both reject unresolved or newer obligations. Viewing, silence and answers never accept a report. Main reads exact events with `job_cards` and calls `handle_job`; a plain acknowledgement addressed to a Ready lead records acceptance atomically without another agent turn. `ozi close --command-id` retries the same command without closing a newer event. Close leaves active work and requests alone.
- Main alone may pass `jobId` to delegation. Retries and related follow-ups pass the existing `jobId` or use the lead's send/queue path. Retrying a failed or unavailable lead reuses its thread and job; the new run supersedes its launch blocker. Helpers inherit the job. An unavailable worker leaves a lead with its blocker and no agent run. Scheduled jobs inherit quiet visibility; internal threads do not appear in cards.
- The current request follows its source event through lead sends, steering and queued follow-ups; event order, not the clock, identifies it.

### Completion (`ozi/Completion.ts`)

- `claim({threadId, runId, requestEventId, reportItemId|null}) → CommandReceipt`; states `checking | continued | checked | needs_user | blocked | superseded`.
- Scheduled and webhook system messages count as requests. Request order follows the conversation even when clock timestamps are equal. Every settled completion creates a candidate automatically, including main, text-only responses, final responses and completion without prose. Checker, interrupted and stopped runs are excluded. The terminal event, candidate and check outbox effect commit atomically before successful delivery or Ready. Recovery uses the same capture path; storage failures retry.
- Checks use T3's native fork paths: Pi waits for `agent_settled` and starts an isolated `--fork` process; Claude and Codex use `ThreadForkService`/`ContextHandoffService`. The source is held only until its native fork exists, then queued input can start before checker inference. There is no checkpoint wait.
- Checkers have an internal, runtime-owned role, the same provider/model and options with low effort, a fixed non-recursive prompt, and evidence-only tools. Options are checked against a refreshed native catalog. Unsupported options, missing native history, malformed JSON, provider failures and a 120-second deadline consume unsuccessful rounds and never pass.
- Verdicts are `{"verdict":"done","useful":boolean}`, `{"verdict":"continue","missing":string,"evidence":string[],"useful":boolean}` or `{"verdict":"needs_user","reason":string,"useful":boolean}`. Done releases the report and deduplicated delivery; continue resumes its owner. Main continues by delegating missing work and owes coordination/reporting, including while background work remains. Human needs, questions, failures and login requests surface immediately.
- Quiet-job checks include the originating scheduled or webhook request from main; useful means its reporting condition is met or the user is needed.
- Three consecutive rounds without verified progress become Blocked in Needs you. Workspace content hashes and completed action receipts are verified independently; new evidence or fulfilled actions reset the count. Read-only tool calls, repeated receipts and rewording do not. Each round retains misses, evidence, verdict/error and input/output token cost, or null when unavailable.
- Steering or Stop supersedes pending results. Late checks can record their evidence and cost, but cannot release old reports or resume cancelled work. Drawers mark pending text unchecked.
- `ozi checks [threadId] --json` exposes records; `ozi wait check <id> <state> --json` subscribes to transitions. Each record contains `id`, `eventId`, `threadId`, `runId`, `requestEventId`, `reportItemId|null`, `report`, `state`, `sourceCaptured`, `unsuccessfulRounds`, `evidence`, `rounds`, and timestamps. Rounds contain their number, checker thread ID, verdict/error, misses, verified evidence, tokens and timestamps.
- Retired: `RunFinalizationService`, `ThreadSettlementService`, inactivity/PR auto-settle, checkpoint storage/services, diff capture, rollback commands and their contracts, client state, UI and replay fixtures. SQLite WAL maintenance is retained. Repair uses git directly.

### Repair (`ozi/Repair.ts`)

- `logMistake({sourceEventId, correctionMessageId?, beforeUserMessageId?, fingerprint, what, why}) → {id, status}`; statuses `logged | testing | failed | shipped | undone`. Dedupe on source event + fingerprint.
- Repair only on a user correction or a repeat. Replay: original must reproduce, candidate must pass the same frozen case, observer must agree; anything inconclusive fails.
- Authoring and both replays run in bwrap: candidate data root writable, `protected/` read-only, no credentials or effect endpoints. Publisher checks the real diff; protected changes only on the user's own message.
- Pass → one data-root commit, activated. Repeat after a fix → revert; conflict with a user edit → keep the pre-fix build and post a blocker.

Logging acknowledges only the SQLite write. Eligible cases run serially as internal delegated tasks; they never create cards or wake main with repair output. Interrupted replays fail on restart, and reserved repair threads cannot resume outside confinement.

A passed replay publishes one local fix commit in the data-root repository. The publisher rechecks the live baseline and allowed paths, preserves the predecessor under `refs/ozi/predecessors/<fixId>`, and journals activation in SQLite before changing files. Prompt, skill and protected-rule access shares the activation lock. Startup completes pending publication or undo before accepting turns; `shipped` and `undone` follow confirmed activation. Repair changes only prompt, ADHD and skill files; server automation and protected authority cannot be changed by a fix. Nothing pushes.

Recurrence logs a new occurrence and undoes the shipped fix without starting another replay. Undo runs a targeted `git revert` in an isolated data-root worktree, preserving later edits. Conflicts restore the affected predecessor files, preserve the user's build under `refs/ozi/user-builds/<fixId>`, and post one Needs you card. Server-owned conflict cards require no active main turn and never start provider work. Manual `undo` retries return the confirmed result. `fixes` includes publication and rollback state, commit, predecessor and conflict information. A crash before journaling leaves the old build; a journaled operation recovers the complete target, with readers excluded while files change. Activation failure restores the saved build before recording failure.

Replay waits for the source turn to settle before freezing native history; an in-progress session write is never parsed. A source that remains active past the deadline fails with `source-settlement-timeout`. `ozi wait replay <id> finished` returns either terminal replay state, including its failure evidence.

Mistake, replay and fix waits subscribe before reading SQLite, then stream committed changes, including publication and undo checkpoints. The CLI owns the requested deadline; waiting never becomes an HTTP 400. M5 tests await unique turn acknowledgements and allow two minutes for serialized replay stages. Pi's fake transport can hold native history incomplete with `{"history":"partial"}` until the turn settles.

Failed replays retain a specific reason and `evidence_json.failure` with the stage and underlying cause, exposed by `ozi replays --json`; sandbox, stage and settlement timeouts have distinct reasons. Author exit validates the candidate before settlement, prompt reads or git diff. Link inspection never resolves the target: relative, absolute, dangling and looping symlinks are `symlink-denied`, including when authoring fails.

`t3_thread_read` supplies `sourceEventId` on timeline items; `ozi events <threadId>` exposes the stored events. Sources must belong to the caller or its descendants; internal checkers can report an ancestor's source. Runtime provider errors use the same logger. `log_mistake` authorizes correction repair only through `correctionMessageId`: a stored user message from CLI or web/desktop, in main or the source job, strictly after the mistaken output. Provider, MCP, server, scheduled and webhook messages have no authority. No text matching grants authority. `beforeUserMessageId` selects the original user-authored request; otherwise use the last such request before the mistake. Invalid references still log; recurrence still triggers repair. A later explicit correction can activate a logged row without duplicating it. A missing replay boundary still logs. Main's turn context includes each message ID; `t3_thread_read` supplies output event IDs.

Cases freeze the original message, native prefix, attachment bytes, expectation and recorded effects. Each replay gets its own native fork and effect-stub counters. Unknown effects, missing history, changed builds, unloaded changes or observer disagreement fail. Shell tools in replays use the frozen stubs. Inference credentials stay in a server-owned proxy; confined processes receive only its socket, a local inference endpoint and fresh provider homes. For each request the proxy rereads Codex's host ChatGPT login, Claude Code's subscription OAuth environment or config credentials, or Pi's Anthropic OAuth environment or auth file. It uses the provider's OAuth endpoint and headers; API-key logins remain supported. Host CLIs own token renewal. Missing, expired, malformed or rejected logins fail with a provider-specific reason on the replay record. Pi's `claude-bridge` uses the pinned bridge and Claude Code binary inside bwrap. Claude Code receives a dummy token and `ANTHROPIC_BASE_URL` for a sandbox loopback listener forwarding only inference to `/inference.sock`; the host proxy adds Claude subscription credentials. Credentials never enter confined files, environment, arguments or proxy responses. The proxy permits only inference POSTs. Protected rules change outside repair through a delegated `change_protected_rule` call backed by `correctionMessageId` referencing the user's exact stored instruction: `Change protected/<filename> to:` followed by the requested content on the next line. Quoted messages and tool output carry no authority.

### Information in

- Every schedule targets `ozi-main`, including schedules created by workers or settings. Runs queue a message with `scheduledTaskId`; main delegates quiet jobs. Dispatch success records delivery only; workers still need checked reports. Quiet jobs persist and recover normally; cards appear for requests or checked reports with `useful: true`.
- Webhooks retain URL tokens, optional HMAC-SHA256 over raw bytes, filters, seven-day replay keys and fixed coalescing windows. External watchers POST to them; Ozi runs no watcher. `serve --public-url` overrides `OZI_PUBLIC_URL`; the HTTP(S) base URL produces `/api/hooks/<id>/<token>`. Without a base URL, `webhookUrl` is omitted.
- `schedule add` takes exactly one of `--every <dur>`, `--at HH:MM [--days 0-6,…]`, or `--webhook`, and `--prompt <text>`. Durations use `ms`, `s`, `m`, `h`, `d` or `w`; intervals are at least one minute. Webhook options: `--secret-ref` (header `x-hub-signature-256`, hex, `sha256=`), repeated `--filter` JSON filter objects, `--replay-key`, `--coalesce-key` and `--coalesce-window <dur>`. `schedules` lists runs; `schedule rm <id>` removes one; `schedule run <id>` queues a manual run.
- Optional server setting `externalTodos`: `{source, server, tool, arguments, itemsPath, fields: {id, title, link, status, due?}}`. `server` is `{type: "stdio", command, args?, env?}` or `{type: "http", url, headers?}`. Paths are dotted field names; empty `itemsPath` selects a root array. Tool output is structured content or JSON text. IDs and titles are nonempty strings, status is a string, link is HTTP(S) or null, due is optional display text. Connection details are excluded from all client settings; only the server calls MCP.
- `todos --configure <json>` replaces that connection; `todos --clear` removes it. `todos` and authenticated `ozi.todos.get` fetch on demand, as does panel open/refresh. No background polling or local task table. Wire result: null without configuration, otherwise `{source, state: "available" | "stale" | "unavailable", items, fetchedAt, attemptedAt}`. Failure preserves the last successful items and timestamp; without success, items and fetchedAt are null. Malformed rows fail the entire fetch. Empty success is distinct from unavailable.
- Only explicit `OZI_TEST_CLOCK=<ISO instant>` enables the scheduler test clock and hidden `test-clock --advance <dur>` CLI command. Advancing triggers scheduler work; production uses the real local clock. Tests observe delivery through `ozi wait`.

### JobPanel (`components/ozi/JobPanel.tsx`)

- The app opens at `/` into `ozi-main`. No thread list, projects, drafts, workspace selectors or branch controls. Settings retain connections (including the terminal command), providers, appearance, keybindings, scheduled tasks and licenses. New schedules target main.
- The desktop window opens independently of its bundled backend. Local startup failure shows an error and leaves Settings → Connections available for a remote server.
- `JobPanel` renders supplied `OziJobCard[]` with answer, handle, stop and open callbacks. Four sections with counts and empty states; Needs you count in the title bar. Questions, approvals, private entry and reports stay on cards. Close and Stop are separate. Status indicators are static.
- Opening a card mounts `JobDrawer`, which loads the lead's brief and conversation on demand. Its composer addresses the lead. The main composer remains mounted and usable. HTML replies, MCP apps and the shared browser remain available. To-dos below jobs, labeled with their source, arrive in M4.
- Client-runtime atoms subscribe to `ozi.jobs.subscribe` with `{}` and send `ozi.jobs.handle`. `useOziJobs` supplies authoritative cards and session freshness. The panel retains its last cards on disconnect, disables mutations until a current snapshot arrives, and surfaces `OziJobError`, including `StaleEvent`. Close preserves its command ID and exact card `eventId`; commands are never acknowledged optimistically. Answers and stop use the existing owner-specific commands.

### Terminal (`cli/tui/`)

- `ozi` without a subcommand opens the terminal app when stdin and stdout are TTYs; otherwise it prints help. It connects like client commands.
- Built from Pi's `pi-tui` and the components and theme `pi-coding-agent` exports: user and assistant messages, editor, loader, borders, markdown and select-list themes. Main-screen mode keeps terminal scrollback. The status line follows Pi's footer style.
- Main's conversation comes from `orchestration.subscribeThread` folded with the shared projection reducer; cards come from `ozi.jobs.subscribe`. Disconnects resubscribe; mutations wait for a current snapshot.
- Layout: conversation, status line (server and connection, Pi-style usage `↑input ↓output used%/window`, model and thinking level; main or job view; Needs you, Running and Ready counts), editor. Alt+Up restores queued follow-ups to the editor and cancels them, as in Pi.
- Keys follow Pi: Enter sends, steering main's active turn when it works; Alt+Enter queues a follow-up, shown until it starts. Esc stops main. Ctrl+C clears the editor; twice exits. Slash commands autocomplete: `/jobs`, `/attach <path>`, `/stop`, `/quit`.
- Keys follow Pi's: Ctrl+T shows or hides thinking, Ctrl+O expands tool output, Ctrl+D exits when the editor is empty, Ctrl+G edits the message in `$VISUAL`/`$EDITOR`, Ctrl+Z suspends. `/hotkeys` lists them. Slash commands Ozi does not own go to main unchanged, so Pi expands prompt templates and `/skill:name` and runs extension commands.
- Appearance follows the local Pi agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`) like Pi's own terminal app: `settings.json` `theme` selects Pi's `dark` or `light` or a custom theme from `themes/` or `settings.themes`, `system` (default) follows the terminal's light or dark report, and `keybindings.json` remaps Pi's action ids (`app.*`, `tui.*`). Colors a custom theme leaves out fall back to Pi's dark theme.
- Image attachments render inline with Pi's terminal image support (Kitty, iTerm2, otherwise a text label); image files attach as image attachments. Ctrl+V pastes clipboard files or images as attachments or text, as in Pi. `@path` mentions of local files (autocompleted after `@`, as in Pi) attach those files to the message, so main gets them even from a remote terminal. `/copy` copies main's last reply (OSC 52, plus the native clipboard when present); `/session` shows the conversation's model, message, tool and token counts.
- Main's Pi commands run through `ozi.main.pi`: `!cmd` runs a shell command on main's Pi and adds its output to main's context, `!!cmd` keeps it out; `/compact [instructions]`, `/export [path]` (HTML, or JSONL for a `.jsonl` path, written on the terminal's machine), `/name <name>`. Autocomplete lists Pi's own commands (prompt templates, skills, extension commands), refreshed after each finished main turn. `/model [model]` and Ctrl+L choose main's model, Ctrl+P and Shift+Ctrl+P cycle models, `/thinking [level]` and Shift+Tab set the thinking level, as in Pi.
- Pi extension UI shows as in Pi's terminal app, within what Pi's RPC mode supports: statuses in the status line, widgets above or below the editor, the title as the terminal title, notices in the conversation, `set_editor_text` in the editor. Main's own select, confirm, input and editor dialogs open over the editor (editor dialogs with their prefill); Esc cancels.
- Sessions follow Pi's on main and its forks. `/new` starts an empty session, `/clone` duplicates the current one, `/fork` forks before an earlier message of the current session and puts that message in the editor (before the first message, an empty session), `/resume` lists main and its forks, most recently updated first, `/tree` nests them by parent, `/import <path>` imports a local Pi session file and continues it, `/reload` restarts the session's Pi on its next turn and rereads the local appearance. Clones and forks are named `<session> clone` and `<session> fork`; `/name` renames the session, also before its first turn. Esc twice on an empty editor opens `/tree`, or `/fork` or nothing per Pi's `doubleEscapeAction`. Pickers search as you type; in the session picker Ctrl+R renames and Ctrl+D deletes a fork. `app.session.new`, `.tree`, `.fork` and `.resume` are bindable, and Ctrl+X copies main's last reply. Like `pi -c`, `-r` and `--session`, `ozi -c` opens the most recently updated session, `ozi -r` opens the picker and `ozi --session <id>` opens that session (unique substrings resolve). The status line names the session and job views return to it; Pi commands, model and thinking changes, extension UI and dialogs act on it.
- `/settings` changes main's auto-compaction, auto-retry, steering and follow-up modes in main's agent directory `settings.json` (also before main's first turn; Pi picks them up on its next turn), and the app's hide-thinking, inline-image, double-Esc and theme settings, saved in the local Pi `settings.json`; each change prints where it was saved. `/scoped-models` picks the models Ctrl+P cycles, saved as Pi's `enabledModels` (exact `provider/id`, substrings and `*` globs); it searches as you type, Ctrl+A enables and Ctrl+X clears all.
- `/jobs` lists cards by column. A card shows title, agent, report and requests. Questions pick an option or take text, approvals allow or deny, secrets use masked input that is never rendered, Blocked takes a reply. Close sends the displayed `eventId`; errors such as `StaleEvent` show as one line. Stop and Open are separate. Open shows the lead's conversation and the editor addresses the lead until Esc.
- Settings → Connections in the packaged desktop app installs or removes the `ozi` command: the app's launcher under its home, linked from a folder on PATH. Unpackaged builds hide the row, so the real-agent run verifies it.
- Tool calls render like Pi's: commands, file changes and Pi tools in boxes colored by status with up to ten output lines; Ozi tool calls as one dim line.
- A card entering Needs you adds one line to the conversation. HTML replies, MCP apps, images and the shared browser show a one-line pointer to the desktop app.

## Retained surface

Device and simulator support is removed, including its RPC methods, MCP tools, settings, models and tool downloads. Shared browser streaming remains. Terminal sessions, their RPC streams, project setup terminals and sign-in terminal rendering are removed. Desktop and server self-update RPCs, update feeds, IPC and controls are removed. Resource monitoring, product analytics and power/activity reporting are removed. macOS packaging has no Rust prerequisite; Linux capture helpers retain their Rust builds. T3 deployment infrastructure and vendored Alchemy references are removed. The T3 welcome wizard and its stored completion marker are removed; provider setup remains in Settings. CLI Proxy quota hubs, their settings, polling, streams and removed quota UI are removed. Native provider usage reporting remains. All product labels and desktop identifiers use Ozi. Desktop and web share the neutral blue icon; package names remain internal.

Only Pi, Claude and Codex providers and desktop, web and terminal clients ship. Provider registration, models, settings, usage and packaging follow this boundary. T3 Connect, cloud accounts, tunnels, relay discovery and signed cloud proofs are removed. Remote pairing over direct network connections, SSH and Tailscale remains. Webhooks use the configured public URL directly. Removal migrations follow M6’s fixes schema.

### Desktop

Ozi shows one environment's main, jobs, to-dos, drawer and composer. Saved remotes take precedence over local: use the client's chosen remote, or the first saved remote when that choice is absent or removed. Use local only without saved remotes. Settings → Connections has one Ozi server picker when multiple environments exist; its choice persists on the client. Disconnection stays on that server and displays its connection state.

## Main agent

Main's environment sets `ENABLE_TOOL_SEARCH=false` so Claude Code adds no deferred-tool placeholder. The bridge is a runtime external in packaged servers.

- Startup creates the sole main thread, `ozi-main`, rooted at `<home>/workspace`. Workers share a per-job scratch directory under `<home>/workspace/jobs/`; execution does not select a project or worktree. One internal workspace record remains for thread persistence and scheduling. It holds identity, root, model and timestamps; worktree defaults, setup scripts, auto-pull and project icons are removed from contracts, settings and SQLite. Project management, worktree launch, source control, pull requests and review APIs are removed. Worktree preparation commands, retries and launch schemas are removed; schedules use the installation workspace. Repository grouping and asynchronous git metadata enrichment are removed from shell projections.
- Thread projections and shells expose `role: "main" | "main-fork" | "worker"` and `effectiveLoadout: {provider, model, options: [{id, value}], toolNames, systemPromptSha256}`. Tool names list Pi's built-ins for main and the injected MCP catalog; the hash covers the server-owned prompt. Main forks retain main's loadout with role `main-fork`.
- Main starts on Pi `claude-bridge/claude-opus-5-5`, `thinking: high`, `fastMode: false`; launch, resume and fork keep the current selection; the user changes it with `ozi thread <id> --model --thinking` or the terminal app. Inference uses the user's Claude subscription through the Claude Agent SDK, not Pi's Anthropic API or OAuth provider. `CLAUDE_CODE_DISABLE_FAST_MODE=1` applies to main's Pi process and its Claude Code children. Unavailable selections fail. Main cannot change its own workspace, provider or model, or archive/delete itself.
- Main is a regular Pi with its own agent directory `<home>/caches/ozi-main-pi`, separate from the user's personal `~/.pi`; it also holds main's Pi sessions. Everything Pi reads from an agent directory applies: MCP servers (`mcp.json`), settings and packages, extensions, skills, prompt templates, context files, `APPEND_SYSTEM.md` and models. `ozi pi <args…>` runs Pi's own CLI against that directory on the server machine, e.g. `ozi pi mcp add <server> -- <command>`, `ozi pi mcp list`, `ozi pi mcp login`, `ozi pi install <package>`. Context files also load from main's workspace and its parents, as in Pi. Changes apply on main's next turn: the server fingerprints the directory and restarts main's Pi session, resuming it, when the fingerprint changes. Ozi adds `--system-prompt …` and explicit extensions for Ozi's MCP bridge and pinned `pi-claude-bridge@0.9.3`, and rewrites only `claude-bridge.json`: AskClaude disabled, strict MCP, auto memory off. Repair replays still run a sealed Pi. A dependency patch sets the SDK's `settingSources: []`; the bridge sets `tools: []` and excludes Claude context files. Claude Code adds no built-in tools, user MCP servers, hooks, skills or CLAUDE.md. The model sees Pi's tools as `mcp__custom-tools__<name>` and Ozi tools as `mcp__custom-tools__mcp__t3-code__<name>`. The server limits main's thread targets to its own descendants; checker-only tools stay unavailable.
- Sessions: Pi's sessions map onto main and its forks. `ozi-main` is the primary session that jobs, schedules and webhooks bind to. Other sessions are `main-fork` threads with main's loadout and their own Pi session file: `thread.fork` clones or branches one, `ozi session new` starts one with no history, `ozi session import` copies a Pi session file's content into main's agent directory and resumes it, `ozi session export [<id>] [--format html|jsonl] [--output <path>]` writes a session's Pi export on the client, and `ozi session reload` releases an idle session's Pi so its next turn reloads extensions, skills, prompt templates, themes and context files. `ozi main <command> --thread <id>` runs Pi commands on any session; `set_session_name` also renames its thread.
- System prompt: `system.md` from the data root (Pi's `SYSTEM.md` role, passed as `--system-prompt`), verbatim, `{{ADHD}}` replaced by `adhd.md` if present, else empty. ≤400 words. Reread at each turn; edits apply on the next turn.
- Tools: Pi's built-in `read`, `bash`, `edit` and `write`, like a regular Pi, plus every Ozi tool workers get: delegation, steer/queue/stop, schedules, secrets, job handling, `log_mistake`, `read_skill(name)`, the shared browser, visual replies, thread management, attachments and `change_protected_rule`. No ambient extensions. Main has the most tools; its prompt decides what it delegates.
- Skills: `read_skill(name)` reads `skills/<name>/SKILL.md` on demand. Unknown names and path or symlink escapes fail.
- Default main delegation: Codex `gpt-6.1-sol`, `reasoningEffort: xhigh`, `serviceTier: priority`. Workers receive one short role instruction to finish their brief, use available tools, handle computer-solvable interactions, ask only for missing decisions or human-only actions, avoid CAPTCHA solvers, and report plainly.

### Standalone Pi package (H2)

`packages/ozi-pi` is a Pi package loaded with `OZI_DATA_ROOT=/absolute/data-root pi -e ./packages/ozi-pi` or installed with `pi install ./packages/ozi-pi`. `--ozi-data-root` overrides the environment; the default is `~/ozi`. It reads an existing data root without seeding or migrating it. Each submitted turn replaces Pi's prompt prefix with `system.md`, substituting optional `adhd.md` into every `{{ADHD}}`. Pi's context and appended prompt remain. Data-root skills use Pi's discovery at startup and reload and its on-demand `read` tool.

The package selects `claude-bridge/claude-opus-5-5`, high, fast off, through pinned `pi-claude-bridge@0.9.3` and the Claude subscription. Its bridge adapter carries the existing SDK isolation patch, adds the session reader export needed by Pi's bundled loader and rebuilds the bridge mirror when the prompt changes. API-key and alternate-cloud environment settings are removed. Delegation policy comes from `system.md`; tool transports come from Pi's MCP configuration. The package does not launch the GUI or replace the current server; GUI wiring and completion checks follow separately.

### Packaged Pi inbox (H3)

`@ozi/pi` ships P3's standalone Pi inbox extension. With `OZI_MCP_URL` and the four ticket tools connected through Pi's MCP configuration, a settled, non-aborted turn snapshots native history and starts an asynchronous `--fork` check with the same model and thinking level. Only `ticket_create`, `ticket_update`, `ticket_close` and `ticket_list` are available to it. The source conversation remains untouched and can accept another turn. The check lists open tickets, files anything requiring an answer or acknowledgement, closes acknowledged tickets and skips small talk. Pi status events report one quiet inbox check with the filed count or failure; checks have a two-minute deadline and clean up their temporary fork.

The extension's shared event-bus guard prevents double installation when the GUI also injects P3. `OZI_INBOX_FORK=1` suppresses recursive checks and preserves the fork's model and thinking selection. Without the GUI MCP connection the extension does nothing.

## Desktop identity

Ozi coexists with T3 Code. Desktop state and the bundled `ozi` shim live under `~/.ozi` or `OZI_HOME`; T3 environment variables and legacy profiles are never read or migrated. Electron uses `Ozi Beta`/`Ozi Dev`, profiles `ozi`/`ozi-dev`, app ID `com.ozi.app` (development `com.ozi.app.dev`) and schemes `ozi`/`ozi-dev`. Locks, safe storage, passkey groups, desktop entries, capture services, browser profiles, caches and WSL paths use Ozi's identity.

The bundled backend runs `ozi serve --bootstrap-fd 3`; WSL uses `serve --bootstrap-fd 0`. Bootstrap data travels through the descriptor. Settings → Connections accepts an Ozi server's pairing URL, including when the local environment is disabled.

## CLI

`ozi wait provider <instanceId> <status>` awaits provider discovery through the server configuration stream.

One binary, `ozi`. Every command takes `--json`. Command failures exit nonzero with one line: `{"error":{"code":"StaleEvent","message":"The job has a newer event."}}` with `--json`, otherwise just the message. Client commands find the server from `--home` (default `~/.ozi`) and authenticate with its owner session.

| Command                                                                         | Does                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ozi`                                                                           | Terminal app.                                                                                          |
| `ozi serve [--home] [--data-root] [--port] [--host] [--public-url]`             | Run the server.                                                                                        |
| `ozi service install\|status\|restart\|uninstall`                               | systemd user service.                                                                                  |
| `ozi pair`                                                                      | Pairing URL for a new client.                                                                          |
| `ozi pi <args…>`                                                                | Pi's CLI on main's Pi agent directory (server machine).                                                |
| `ozi connect <pairing-url>` / `ozi disconnect`                                  | Save or remove a remote server for client commands.                                                    |
| `ozi request <RPC-or-path>… [--method GET\|POST] [--payload JSON]`              | Send authenticated requests and report each RPC result or HTTP status.                                 |
| `ozi status`                                                                    | Server, main thread, effective loadouts (model, options, tools, prompt hash), providers.               |
| `ozi say <text> [--file <path>]…`                                               | Message main; queues when busy.                                                                        |
| `ozi -p\|--print <text>… [--thread <id>] [--file <path>]…`                      | Print mode: send prompts in turn, print each reply.                                                    |
| `ozi steer <text> [--thread <id>]`                                              | Steer the active turn.                                                                                 |
| `ozi session new\|list\|import\|export\|reload`                                 | Pi sessions on main and its forks: start, list, import or export a Pi session, reload Pi.              |
| `ozi main <command> [--payload JSON] [--thread <id>]`                           | Run an allowlisted Pi RPC command on main or a session.                                                |
| `ozi settings [--auto-compaction\|--auto-retry on\|off] [--…-mode m]`           | Read or change main's Pi settings: auto-compaction, auto-retry, steering and follow-up modes.          |
| `ozi stop [--thread <id>]`                                                      | Stop a thread's work.                                                                                  |
| `ozi thread <id> [--provider <id> --model <model>] [--fork] [--message <text>]` | Transcript, loadout, state; select a worker model, fork the latest stable run, or send to that thread. |
| `ozi jobs`                                                                      | Cards by column.                                                                                       |
| `ozi job <id>`                                                                  | Card plus lead transcript.                                                                             |
| `ozi answer <requestId> <value…>`                                               | Answer a question, approval (`allow`/`deny`) or secret.                                                |
| `ozi close <jobId> <eventId>`                                                   | Handle a card.                                                                                         |
| `ozi checks [<threadId>]`                                                       | Check rounds and verdicts.                                                                             |
| `ozi mistakes` / `ozi mistake <id>`                                             | Mistake log.                                                                                           |
| `ozi replays`                                                                   | Replay cases and results.                                                                              |
| `ozi fixes` / `ozi undo <fixId>`                                                | Shipped fixes; manual undo.                                                                            |
| `ozi schedules` / `ozi schedule add\|rm\|run`                                   | Interval, time-of-day and webhook schedules bound to main.                                             |
| `ozi todos`                                                                     | External to-dos with source and freshness.                                                             |
| `ozi wait <job\|thread\|check\|mistake\|replay\|fix> <id> <state> [--timeout]`  | Block until the state holds; non-zero on timeout.                                                      |
| `ozi events <threadId>`                                                         | Stored source events for diagnostics and mistake logging.                                              |

Client commands use the running server under `--home`, else the remote saved by `connect`: its pairing token is exchanged once for a bearer session stored owner-only in the home; an expired or revoked session fails asking to connect again. Without `--json`, `status`, `jobs`, `job`, `thread`, `checks`, `mistakes`, `replays`, `fixes`, `schedules` and `todos` print short text and other commands print one line. Text shows IDs by their shortest unique suffix of at least eight characters; ID arguments accept any unique substring, and ambiguous ones fail.

M1 implements `serve`, `service`, `pair`, `status`, `say`, `steer`, `stop`, `thread`, and `wait`. M2 adds `jobs`, `job`, `answer`, `close`, and `wait job`. M3 adds `checks [threadId]` and `wait check`. Other commands arrive with their owning milestones. `--home`/`OZI_HOME` selects server state; `--data-root`/`OZI_DATA_ROOT` selects the data repository. Desktop launchers may use the `--base-dir` alias.

The CLI resolves main by its fixed `ozi-main` ID; worker and fork activity never changes the default target. `status` returns server configuration, the shell snapshot and the complete main projection with its effective loadout; `thread` returns the complete thread projection. `--fork` creates a child from the latest stable run; other thread flags then address the child. `--model` and `--thinking` change main's and its sessions' selection too. `job` returns `{card, lead}`; `jobs` returns a card array. `answer` routes questions, allow/deny approvals, secret entry and checker blockers to the request's owning thread. `wait thread <id> text:<substring>` waits for transcript text; `wait job` uses `needs_you`, `running`, `ready`, or `done`. JSON errors retain a non-zero exit code. Uploaded text files include their name, saved path and UTF-8 content in main's prompt so main can delegate a complete brief without file tools.

## E2E

`e2e/` runs the real server (`ozi serve` on a temp home and temp data root), real SQLite, files, git and bwrap, the real web client in Chromium, and the `ozi` CLI. Fakes only: provider transports (`e2e/fakes/{pi,codex,claude}` executables on `PATH`, speaking each native protocol and calling real MCP tools from a scenario script), the clock, and external MCP. Tests await observable state via `ozi wait`, never sleeps.

A milestone passes when its scenarios pass here and its real-agent run passes: real Pi/Opus 5.5 main, Codex and Claude workers, the desktop app on a second machine.

Scenario scripts are JSON arrays at `OZI_FAKE_SCRIPT`. Rules match prompt regular expressions, optionally `provider` (`pi`, `codex`, `claude`) and `role` (`main`, `worker`). Matching rules run once in order unless `repeat` is true. Steps are `{"say":"text"}`, `{"tool":{"name":"read_skill","arguments":{"name":"demo"}}}`, `{"ask":"question"}`, `{"approval":"command"}`, `{"wait":true}` or `{"fail":"reason"}`. Tools use the real authenticated MCP endpoint. `$prompt`, `$result` and `$result.field` interpolate the prompt or last tool result. `OZI_FAKE_LOG` records launches, received protocol frames, prompts, tools and results with credentials redacted.

Install Chromium with `pnpm --filter @ozi/e2e exec playwright install chromium` before the first E2E run. Linux desktop tests require `pkg-config`, `libsecret-1-dev`, `xvfb`, `dbus`, `gnome-keyring` and `libglib2.0-bin`; saved credentials use a private D-Bus session and real temporary keyring. Setup builds the desktop, server and web bundles and ensures the Electron runtime. On Linux run `xvfb-run -a vp test run --root e2e`. The harness uses isolated provider homes and kills only its own processes. `OZI_E2E_KEEP=1` preserves temporary artifacts after teardown.

### M1 Connection

- `m1.fresh-install`: missing and empty data roots start from packaged defaults (`system.md`, protected approvals, contacts and credentials, empty `skills/` and `protected/cases/`) with one git commit, without user git configuration; main's prompt hash matches the default with its ADHD slot cleared. Restart changes no files or git history, including after user edits or removals; a committed legacy `prompt.md` becomes `system.md` in one rename commit, keeping uncommitted edits elsewhere. `ozi status` shows main and providers pi, claude, codex only.
- `m1.main-loadout`: main is Pi, `claude-bridge/claude-opus-5-5`, high, fast off; prompt equals data-root prompt with empty ADHD slot; tools are Pi's built-ins plus every Ozi worker tool; same after resume and fork. Real Pi, bridge and Claude Code send that prompt and exactly those tools to a fake Anthropic endpoint, with ambient Claude configuration excluded and the workspace's `AGENTS.md` loaded as in Pi.
- `m1.main-tools`: main launches like a regular Pi, without tool, MCP, extension, skill, context or template restrictions, with every Ozi tool workers get and no Claude Code built-in tools; checker-only tools are rejected.
- `m1.delegate-async`: request → main starts a Codex worker (gpt-6.1-sol, xhigh, Fast), confirms it started, its turn ends; worker result returns to main, which reports.
- `m1.responsive`: while a worker runs, a second message gets an answer.
- `m1.worker-choice`: main sees Pi's subscription models with Opus first and no `default`; Claude and Pi workers start with the selected models and bridge loading.
- `m1.attachments`: a file sent with a message reaches main and the worker brief.
- `m1.steer-queue-stop`: steer main mid-turn; queue a follow-up; stop main; stop a worker.
- `m1.read-skill`: main loads a data-root skill by name; unknown name errors.
- `m1.remote-client`: web and built Electron clients pair with the server over its network address and chat. With local off, Electron reopens its saved remote main and jobs; remote selection persists, including with local on, and disconnect never switches servers.
- `m1.cli-json`: every implemented `ozi` command returns valid JSON with `--json`; errors have a code and one-line message, plain errors print only the message; native forks of Pi, Claude and Codex workers preserve the source conversation.

### M2 Jobs

- `m2.lead-card`: a delegated request shows one Running card at once.
- `m2.helper-same-job`: a worker's helper inherits the job; still one card.
- `m2.second-outcome`: an unrelated request makes a second card.
- `m2.followup-lead`: a related follow-up runs in the lead thread; retrying a failed or unavailable lead with `jobId` ends with one Ready card, including after restart.
- `m2.question-card`: a helper's question moves the card to Needs you; answering it on the card resumes that helper.
- `m2.approval-card`: a worker approval shows on the card; deny and allow reach the owner.
- `m2.secret-card`: a secret request shows on the card; the value never appears in card data.
- `m2.awaits-check`: a finished worker stays Running (checking), never Ready.
- `m2.drawer`: clicking a card opens the lead conversation in a drawer.
- `m2.no-thread-list`: the UI has no thread list or projects.
- `m2.main-without-worker`: if a worker can't start, a lead thread with the blocker shows in Needs you.
- `m2.restart`: after a server restart, cards and columns are unchanged; retried commands don't duplicate.

### M3 Completion

- `m3.worker-done`: a worker claim is checked; `done` → Ready with the report.
- `m3.continue`: `continue` resumes the worker, which finishes; then Ready, and main receives the result.
- `m3.blocked`: three rounds without progress → Blocked in Needs you.
- `m3.progress-resets`: verified progress resets the round count.
- `m3.main-checked`: main's text-only claim is checked; `continue` makes main delegate.
- `m3.no-recursion`: checker runs are never checked.
- `m3.fork-intact`: each provider's fork leaves the source session unchanged and usable.
- `m3.bad-verdict`: malformed verdict or checker error counts as an unsuccessful round.
- `m3.steer-supersedes`: steering during a check discards its verdict.
- `m3.stop-unchecked`: stopped work is not checked.
- `m3.needs-user`: `needs_user` moves the card to Needs you at once; after the answer the worker finishes, the card is Ready and main receives the result.
- `m3.close-exact`: closing the shown report → Done; a stale event returns clean `StaleEvent` JSON or a plain message; a newer result reopens.
- `m3.accept-closes`: clear user acceptance closes the card.
- `m3.close-vs-stop`: Close hides without stopping; Stop shows Needs you / Stopped without checking or accepting; close → Done, a new request → Running.
- `m3.recovery`: a crash before fork or delivery recovers without losing or duplicating the report.

### M4 Information

- `m4.interval`: an interval schedule wakes main; nothing useful → no card.
- `m4.time-of-day`: a fixed-time schedule fires at the faked time.
- `m4.useful-card`: a scheduled run with a checked useful finding makes a card; the checker receives the originating request and respects its reporting condition; unchecked or routine reports remain quiet across restart.
- `m4.webhook`: a signed POST wakes main; bad signature rejected; duplicate suppressed; filter applied.
- `m4.base-url`: schedules report webhook URLs on the configured base URL.
- `m4.todos`: external to-dos show labeled; offline/malformed source shows unavailable, not empty; no config hides them.
- `m4.removed`: the real server rejects all retired RPC methods and Connect routes, CLI commands are absent, and removed tracked package sources, paths and native resource-monitor bundling are gone. Ozi desktop metadata and macOS preflight have no T3 identity or Rust requirement.

### M5 Replay

- `m5.log`: `log_mistake` writes one row; a retry dedupes; unknown cause stays `unknown`.
- `m5.no-repair-once`: a single uncorrected mistake starts no repair.
- `m5.correction-repairs`: natural correction text with explicit message references starts repair; webhook, tool, unknown and earlier references do not. Baseline reproduces, candidate passes, observer agrees. Real Pi, bridge and pinned Claude Code replay main inside bwrap through the trusted proxy to a fake Anthropic endpoint.
- `m5.repeat-repairs`: a repeated mistake starts a repair after the logging turn settles, even when native history is partially written during the turn.
- `m5.false-case`: a baseline that doesn't reproduce fails the replay; failure causes and timeout reasons survive restart.
- `m5.unknown-effect`: an unstubbed effect fails the replay.
- `m5.protected-denied`: a candidate writing `protected/` or escaping the root is denied by bwrap and rejected by the publisher; symlinks are rejected before target resolution, even after author failure.
- `m5.no-credentials`: authoring and replays infer through host OAuth logins without reading credential paths or values or reaching effect endpoints; unusable logins fail closed with a clear replay reason.
- `m5.user-override`: the user's own message can change a protected rule; the same text from an email or tool can't.

### M6 Publish/undo

- `m6.publish`: an explicitly referenced natural user correction leads to one passed fix commit, active in the next turn and after restart.
- `m6.recurrence-undo`: the mistake recurring after a fix reverts it → `undone`.
- `m6.edit-conflict`: a revert conflicting with a user edit keeps the pre-fix build and posts a blocker.
- `m6.crash-publish`: real server crashes before journaling and at journal, file, git-head and confirmed-state boundaries of publish and undo recover a complete build with matching status; conflict recovery posts its blocker and retries create no duplicate activation. Each crash boundary is an independent E2E case with its own deadline.
- `m6.audit`: no excluded T3 product paths, exports or dependencies remain. Inherited unit, component and browser tests, fixtures, testkits and their exclusive dependencies are removed; tests live only in `e2e/`. Knip checks unused runtime files, exports and dependencies; dynamically loaded bridge and E2E entry points are explicit. E2E guards reject retired imports, capability flags, sidebar/diff settings, T3 product text, role preambles and comments in Ozi modules. Snooze commands, recovery settings and stored fields are removed; old snooze events migrate to metadata updates. Delegated briefs remain verbatim under the single worker role. Project preference overrides, their legacy fold and startup sweep are removed; provider and browser preferences apply to the server. The desktop audit scans tracked desktop runtime and packaging source, shared desktop identity boundaries, and all source environment variables; notices, vendored references, tests and documentation are allowed. It builds the desktop bundle, checks local and WSL launch argv, starts the bundled server with isolated state beside a T3 sentinel, and pairs another server through Settings → Connections.
- `m6.public-ready`: T3 Code, Pi, Firstmate and pi-claude-bridge MIT notices, and Claude Code/Agent SDK terms are present in the repo and packaged notices. Public setup uses packaged defaults. Every tracked file is checked for personal home paths, emails, private network addresses, provider tokens and private keys; only vendored `.repos/` and license texts are exempt.

Product descriptions and connection guidance use Ozi and self-hosted public URLs.

### M7 Terminal

The harness runs `ozi` in a real pseudo-terminal through util-linux `script`, types keys on stdin and reads its output with control sequences removed.

- `m7.cli-text`: without `--json`, listing commands print short text with short IDs; a unique ID substring resolves and an ambiguous one fails in one line.
- `m7.remote-cli`: a second home connects with a pairing URL; `say`, `jobs`, `answer` and `wait` reach the first server; a used or invalid token and a revoked session fail in one line; `disconnect` removes the saved remote.
- `m7.tui-chat`: the app opens on main; a typed message reaches main and its markdown reply renders; a command main runs shows as a tool box with its output; Enter while main works steers it; Alt+Enter queues a follow-up that stays queued after Esc stops main; `/attach` sends a file; Ctrl+C twice exits.
- `m7.tui-question`: a worker's question adds a Needs you line and count; picking an option in `/jobs` resumes the worker and the card reaches Ready.
- `m7.tui-close`: closing a Ready card moves it to Done; closing a card whose event changed shows `StaleEvent` and changes nothing.
- `m7.tui-secret`: a secret request takes masked input; the value never appears on screen or in card data.
- `m7.tui-lead`: opening a card shows the lead's conversation; a message typed there reaches the lead; Esc returns to main.

### M8 Main as a full Pi

- `m8.pi-config`: `ozi pi mcp add` writes main's Pi agent directory; on main's next turn, without restarting Ozi, real Pi sends the model that server's tools next to Pi's and Ozi's tools, and a skill and `APPEND_SYSTEM.md` in that directory load; the personal `~/.pi` config does not.

### M9 Pi parity

`ozi pi <args…>` uses local Pi with inherited stdio when the home has a live local server or no saved remote, including before server startup. Otherwise it calls authenticated `ozi.pi.run` on the saved remote with operate scope and returns Pi's stdout, stderr and exit code. The server uses its configured Pi binary, main's agent directory and workspace, closed stdin, a five-minute timeout and a 1 MiB output cap per stream. Empty arguments fail in one line: "Run `ozi pi` without arguments on the server machine." `--home` selects the client connection without writing a local Pi agent directory; arguments after `--` pass through unchanged.

Everything Pi's interactive mode and harness do, Ozi's main and terminal app do; Pi's sessions are main and its forks. Waves: (1) slash pass-through, thinking, tool expansion, Pi keys, main's Pi RPC (`ozi main <command>`: commands, stats, bash, compact, export, last reply, name), extension commands, model and thinking switching; (2) footer usage and model, `!`/`!!`, `/compact`, `/copy`, `/export`, `/session`, `/name`, `/model`, `/thinking`, Ctrl+L, Ctrl+P, Shift+Tab, command autocomplete, extension UI (notify, status, widgets, title, editor, editor text), themes and keybindings from main's agent directory, inline images, clipboard paste, queued-message restore; (3) `/new`, `/fork`, `/clone`, `/tree`, `/resume`, `/import`, `/reload`, `/settings`, `/scoped-models`, print mode. Out of scope: `/login` and `/logout` (main signs in through the Claude subscription; `ozi pi` runs Pi's other auth commands), `/share`, `/trust`, `/bug`, `/changelog`, and extension components Pi's RPC mode cannot carry (custom components, header, footer).

Print mode (`ozi -p`, `ozi --print`, `ozi print`) sends each prompt to main or `--thread` in turn and prints that run's last reply; `@path` arguments attach files to the first prompt like `--file`. `--json` prints `{threadId, runId, status, text}` per prompt; `--mode json` also streams the thread's events as JSON lines before each result, like Pi's JSON mode. It exits non-zero when a run fails, is interrupted or cancelled, or stops on a question, naming the `ozi answer` to give.

- `m9.pi-rpc`: with real Pi, `ozi main` fails in one line before main's first turn, then returns Pi's commands, session stats, last reply, models, thinking levels and state, names the session, exports HTML, runs bash into and outside main's context, aborts bash and compacts; commands outside the allowlist fail without changing state.
- `m9.slash-passthrough`: with real Pi, extension commands complete main's turn without inference, an assistant reply or a check; a prompt template expands with its arguments before the model request.
- `m9.model-switch`: with real Pi, the user's `ozi thread ozi-main --model --thinking` shows in main's loadout and reaches the next model request (model, effort, fast mode off).
- `m9.extension-ui`: with real Pi, an extension's notices (last 20), statuses, widgets, title and editor text persist on main's thread across a restart, and its select, editor, input and confirm dialogs are answered or cancelled from the web app and `ozi answer`.
- `m9.tui-slash`: an unknown `/command` typed in the terminal app reaches main unchanged; `/hotkeys` stays local; Ctrl+D exits on an empty editor.
- `m9.tui-thinking`: main's thinking shows in Pi's thinking style and Ctrl+T hides it to a "Thinking..." label; a long command shows ten lines and Ctrl+O expands it.
- `m9.tui-editor`: Ctrl+G opens the message in the external editor and its saved text is sent.
- `m9.tui-footer-dequeue`: the status line shows main's model, thinking level and token usage after a turn; Alt+Up puts a queued follow-up back in the editor and cancels its run; Esc stops main even with text in the editor.
- `m9.tui-media`: an attached PNG renders inline, `/copy` copies main's last reply through OSC 52, `/session` shows message counts, and an `@file` mention attaches the file.
- `m9.tui-pi-commands`: with real Pi, `!echo` shows its output, `/name` and `/compact` succeed, `/export` writes HTML and JSONL locally, `/model` switches main's model, Shift+Tab changes the thinking level, and a prompt template in main's agent directory appears in autocomplete.
- `m9.sessions`: `ozi session new` creates an empty main-fork whose first turn starts a new Pi session; messages to it stay out of main; `ozi session list` shows main and it; `ozi main --thread` reaches its Pi; `ozi session reload` relaunches an idle session's Pi on its next turn.
- `m9.session-import`: with real Pi, a remote client exports main's session as JSONL (identical to Pi's file) and HTML; the JSONL imported from the remote client resumes with its conversation in the next model request, survives a restart and leaves the source unchanged.
- `m9.tui-sessions`: in the terminal app `/clone` duplicates main, `/resume` switches back, `/fork` from the second message branches after the first run with that message in the editor, `/tree` nests the forks, `/new` starts an empty session, `/fork` from its first message starts another, and `/reload` confirms; `ozi -c`, `--session` and `-r` open the latest session, a named one and the picker, where search, Ctrl+R and Ctrl+D rename and delete a fork.
- `m9.tui-import`: with real Pi, `/import` of a copied session file opens it as a session that answers, apart from main.
- `m9.tui-settings`: with real Pi and before main's first turn, `/settings` turns main's auto-compaction off in main's agent directory, `ozi settings` sets the steering mode and auto-retry there, and hides thinking in the local settings; Ctrl+P cycles only the scoped models; `/scoped-models` saves `enabledModels`, Ctrl+A clears the scope and Ctrl+X empties it.
- `m9.tui-extension-ui`: with real Pi, an extension command's notice, status, widget and editor text appear, and its select, editor and confirm dialogs are answered in the app.
- `m9.print`: piped stdin plus a message reach main as one prompt and only its reply prints; several prompts run in order; an `@file` argument attaches the file; `--json` returns the run; `--mode json` streams events then the result; a question and a failed run exit non-zero with one line.
- `m9.remote-pi`: a paired remote client's `ozi pi mcp add` writes main's server agent directory without creating one on the client; empty arguments fail in one line, Pi failures preserve stderr and exit code, and local Pi commands still run with the server stopped.
- `m9.tui-appearance`: a custom Pi theme and `keybindings.json` in the local Pi agent directory change the app's colors and keys.

### H2 Standalone Pi

- `h2.pi-package`: real Pi loads the package with its own `-e` mechanism, selects the subscription bridge with high thinking and fast off, sends the data-root prompt with absent and present ADHD content across two turns without restarting, discovers a data-root skill and reads it through Pi's tool. An ambient Anthropic API key is never sent.

### H3 Packaged inbox

- `h3.pi-inbox`: plain Pi loads the inbox extension from `@ozi/pi`, files one Review ticket from an isolated native fork, skips small talk and closes an acknowledged ticket. Forks retain the source model, thinking and conversation with only the four ticket tools; source history stays unchanged. `OZI_H3_REAL=1` checks filing through the real Claude subscription.
- `h3.gui-dedup`: GUI injection before or after the package produces one check per turn and one ticket, using the existing shared event-bus guard.
- `h3.no-mcp`: plain Pi without a GUI MCP connection continues normally without an inbox check.
- `h3.fork`: an inbox fork never installs another check.

### H4 Harness repair

The standalone Pi package owns repair and the shared M5–M6 sandbox and publisher. The existing server uses adapters to the same implementations. No GUI connection is required. State lives beside the data root in a sibling `.<root-name>-harness/` directory, with SQLite, frozen cases and publication worktrees. A missing data-root git repository receives an initial local commit; existing files remain intact.

`repair_context` exposes native message IDs. `log_mistake` deduplicates by native assistant event and fingerprint, acknowledges the SQLite write and authorizes repair only with a later direct Pi input or a repeat. Extension-generated inputs cannot authorize corrections. `change_protected_rule` requires the exact stored user instruction. Repairs run serially outside the conversation, after `agent_settled`, through the inference-only proxy and bwrap. Author and observer sessions do not receive repair tools; frozen instructions are data. Replays use independent native forks, frozen attachment bytes and effect counters. Unrecorded effects, unloaded changes, changed baselines, observer uncertainty and protected or symlink writes fail closed.

`ozi-harness mistakes|replays|fixes|undo <fixId> --data-root <root> --json` reads or changes that root's repair state. `sessions`, `events <sessionId>` and `mistakes log --session <sessionId> --input <json>` expose the same native logging boundary for operators. `worker` drains eligible repairs; Pi starts it after settlement and on startup. `wait mistake|replay|fix <id> <state> --timeout <seconds>` subscribes before reading; replay `finished` includes failure evidence. Publication and prompt/protected reads share an activation lock across processes. Startup recovers journaled publication or undo before the next prompt. Recurrence undoes the shipped fix without another replay. Conflicts preserve the user's build ref, restore the affected predecessor files and persist one blocker, exposed by `blockers` and in Pi notifications, without inference. Nothing pushes.

- `h4.repair`: real Pi and Claude Code with fake inference log and deduplicate a native mistake, accept a later correction, freeze history, author and replay in bwrap, approve through an observer, activate one commit and undo idempotently while preserving unrelated edits. With `OZI_H4_REAL=1`, the same case uses the real Claude subscription.
- `h4.protected`: a confined author cannot change protected rules or publish a fix.
- `h4.symlink`: a dangling authored symlink is rejected before target resolution.
- `h4.observer`: disagreement prevents publication.
- `h4.unknown-effect`: an unrecorded replay effect fails closed.
- `h4.conflict`: conflicting later edits are preserved under the user-build ref; undo restores the predecessor and records one blocker.
- `h4.recurrence`: a repeated fingerprint logs a new occurrence and undoes the fix without a second replay.

- `h4.crash-undo`: killing the CLI after its undo journal is committed recovers the complete predecessor before Pi accepts the next prompt, with one confirmed undo.
- `h4.package`: the CLI runs from an installed `node_modules` package without a build.
- `h4.skills`: native Pi file reads load the candidate skill during replay and the active skill on the next turn; undo restores it.
- `h4.long-path`: repair publishes and undoes with a deeply nested data root; the private inference socket uses a scoped short temporary path independent of that root.

### H5 Harness completion

The standalone package requires `completion_check({workerId, files, ticket, ticketId?})` before filing a worker's finished job as Review. Main first inspects diffs, test output and exit status, files and PR state through its tools. The check reads the completed worker through the GUI, hashes workspace files with the existing evidence reader, and forks main's completed native prefix into an isolated Pi process on the same subscription model at low effort, without tools, extensions or inbox recursion. The fork judges the proposed Review against the actual history and evidence, returning the existing completion verdict plus specific verified facts. File and worker evidence and the current request are checked again before delivery; changes or cancellation supersede the result.

Explicit checks judge only the worker's assigned obligations and proposed Review. Main's check invocation, resulting ticket and later report cannot be prerequisites for the worker to pass. Automatic checks separately judge main's own response.

A pass creates or updates Review through the GUI's `ticket_*` tools with verified facts and evidence references appended. Continue sends specific missing obligations to the worker; three rounds without verified file progress file a Read failure. Decisions and approvals file Decide; human actions file Do. Missing history, evidence, malformed output, checker failure or its 120-second deadline file Read failure and never Review. Direct worker Review creation or promotion is blocked; an inbox fork with no worker activity can still file its own turn result. The GUI owns ticket storage and attaches calling-session IDs. `ozi-harness checks --json` exposes native request and worker IDs, verdicts, evidence, verified facts, failure state and delivery receipts; `wait check <id> <state>` subscribes before reading.

- `h5.review`: real Pi and Claude Code with fake inference and external GUI MCP reject unchecked Review creation/promotion, verify real files and a git diff, and file one Review with verified facts. `OZI_H5_REAL=1` uses the real subscription for the same check.
- `h5.worker-scope`: worker checks receive a worker-only scope; automatic main checks receive the main scope.
- `h5.continue`: a missing test sends the worker back with the gap and creates no Review.
- `h5.blocked`: three unchanged rounds send back twice and then file Read failure.
- `h5.needs-user`: a human approval requirement files Decide without Review.
- `h5.malformed`: malformed checker output files Read failure.
- `h5.stale`: worker evidence changing during the check supersedes it without delivery.
- `h5.update`: an existing ticket becomes Review only through a verified update.
- `h5.file-error`: unavailable evidence files fail closed without checker inference or Review.
- `h5.file-stale`: file contents changing during verification supersede the check without delivery.
- `h5.duplicate`: repeating a passed check against unchanged evidence returns the existing receipt without a second ticket.
- `h5.gui`: with `OZI_H5_GUI_ROOT` pointing to an I2-capable GUI checkout, real subscription Pi changes files, main receives its review request through the composer, and the inbox shows a verified Review linked to main. State is temporary, both dev servers stop, and a screenshot is retained.

- `h5.inbox-worker`: an inbox fork inheriting an unchecked worker report cannot bypass the completion gate and file Review.

### H6 Automatic main completion

The Pi package automatically checks each successful settled main response, including text-only replies, through H5's isolated native checker and verdict policy. Main records have `workerId: null` and the native `reportItemId`; explicit worker checks retain their IDs and Review gate. Interactive main stays available during checker inference. A new request, session switch, shutdown or aborted run supersedes pending work; late results never continue it. Passing checks stay silent and leave native source history unchanged. Inbox and checker forks never check themselves.

Continue follows up on the same main session with the missing obligations and instructions to use `delegate_task`, coordinate and report back. The original user request scopes the consecutive-round count. Three rounds without independently verified file progress stop continuation; needs-user and checker failures surface attention without automatically resuming main. Check records and waits use the existing `ozi-harness checks` and `wait check` CLI.

- `h6.main-checked`: a text-only main claim is checked automatically; continue makes main delegate the gap and a later check passes.
- `h6.fork-intact`: a passing check leaves the source session unchanged and usable for another request.
- `h6.no-recursion`: inbox forks never start completion checks; checker forks have no tools or Ozi extensions.
- `h6.blocked`: three rounds without verified progress stop main's continuation.
- `h6.malformed`: malformed checker output fails closed without continuing main.
- `h6.needs-user`: a human need surfaces attention without continuing main.
- `h6.superseded`: a replacement request starts while a checker is pending and supersedes its old continuation.

### H7 Delegated completion identity

`completion_check.workerId` accepts the task/node ID or child thread ID returned by `delegate_task`. GUI `task_status` resolves task IDs to child threads before history reads, continuation sends and check lookup. Successful resolution stores the child thread ID, so switching identifiers preserves duplicate receipts and unsuccessful rounds. A task without a child thread fails closed.

GUI input provenance persists an `ozi-request` native entry for real requests, including schedules. Delegated completion and other runtime notifications keep the existing request. Both automatic and explicit checks use that stable anchor across native user-shaped notifications and restarts. Plain Pi retains native user-message boundaries. Superseded checks never become the settled round or progress baseline; verified file changes reset the counter, and three unsuccessful rounds block even when the checker fails.

- `h7.task-id`: a delegated task ID reads and verifies its child and files Review.
- `h7.task-duplicate`: repeating a checked task by child thread ID reuses the receipt without another check or ticket.
- `h7.task-blocked`: alternating task and child thread IDs shares three unsuccessful rounds, sends missing work only to the child, then files Read.
- `h7.task-unbound`: a task without a child fails without checker inference or Review.
- `h7.request-identity`: with `OZI_C6_GUI_ROOT`, the real GUI delegates a staged worker; notifications preserve one request, a file change resets the count, and unchanged rounds reach Blocked. Only inference is faked.

- `h7.gui`: with `OZI_H7_GUI_ROOT`, real subscription main delegates through the GUI, checks using the returned task ID and files a verified Review; the inbox screenshot is retained.
