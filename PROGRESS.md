# Progress

Milestone 9 (Pi parity) is built and its E2E passes on `main`: M9 adds 18 scenarios, `node scripts/features.ts check 9` passed, every requirement has a feature and all 35 features pass. Real-agent runs R1–R9 passed on the Ubuntu server under systemd. R7's Mac run used the MacBook Air because the MacBook Pro was asleep and offline; the Pro run follows when it is back.

## Done

- Fork pinned at T3 v0.1.1 (`fe27e8e`); `origin` = github.com/JohanSardar/ozi (public). Work lands as small PRs merged on green CI.
- Data root `~/ozi` (git): `system.md` verbatim, `protected/`, `skills/`. Pi 1.4.0.
- SPEC.md, features.yaml, `scripts/features.ts` (check + HTML; reads all `e2e/results*.json`).
- M1: other providers, mobile and marketing cut. Main = Pi + Opus 5.5 on the user's Claude subscription through `pi-claude-bridge` (Claude Agent SDK; `--provider claude-bridge --model claude-opus-5-5`, thinking high, fast off), no built-in tools, verbatim data-root prompt, Ozi MCP tools only; default worker Codex gpt-6.1-sol xhigh Fast. `ozi` CLI with `--json`. Fake-agent harness plus real-binary checks (real Pi, real bridge, pinned Claude Code against a fake Anthropic endpoint). Fresh installs seed the data root.
- M2: one main conversation, JobPanel per the mockup, worker drawer; Jobs cards via `ozi.jobs.get|subscribe|handle`; CLI `jobs`, `job`, `answer`, `close`, `wait job`.
- M3: every claim checked by an isolated native fork against the originating request; continue/needs_user/blocked; exact disposition; checkpoints/finalization/settlement cut.
- M4: schedules and webhooks bound to main, quiet jobs, self-hosted webhook URL, test clock, external to-dos from one MCP source; devices, simulators, terminal, source control, pull requests, T3 Connect/cloud/relay, analytics, onboarding, quotas, launch workflows and self-updates cut.
- M5: mistake log, explicit server-verified correction references, replay in real bwrap (no network; trusted inference proxy using the host's OAuth logins), protected rules, user-only override.
- M6: publish as one data-root commit activated on the next turn, recurrence undo and manual undo with crash-safe journal; gardener audit (E2E-only tests, Knip clean, no retired imports/settings/instructions/comments, no T3 identity); public-ready README, LICENSE and third-party notices (T3 Code, Pi, Firstmate, pi-claude-bridge, Claude Agent SDK) with a tracked-file privacy check.
- M7: `ozi` without a subcommand opens a Pi-style terminal app on Pi's `pi-tui` with Pi's dark theme and keys (Enter sends or steers, Alt+Enter queues a follow-up, Esc stops, Ctrl+C twice exits). It shows main's live conversation and status, and `/jobs` answers questions, approvals and masked secrets, closes against the shown event, stops jobs and opens lead conversations. `ozi connect <pairing-url>` reaches a remote server; commands print short text without `--json` and accept unique ID substrings; the packaged desktop app installs `ozi` on PATH from Settings → Connections. First frame about 0.2 s, full conversation about 0.5 s with the bundled build.
- M8: main is a full Pi with the most tools: Pi's `read`, `bash`, `edit` and `write`, every Ozi tool workers get, and everything Pi loads from its own agent directory (MCP servers, packages, extensions, skills, prompt templates, context files). `ozi pi <args…>` runs Pi's CLI on it (`ozi pi mcp add …`), and changes apply on main's next turn. Delegation follows main's prompt, not missing tools. The terminal app shows tool calls the way Pi does.
- M9: Pi parity. Main takes Pi's RPC commands (`ozi main <command>`, any session with `--thread`); the user switches main's model and thinking; extension UI (notices, statuses, widgets, title, editor text, select/confirm/input/editor dialogs) persists on the thread and shows on desktop and in the terminal. Pi's sessions are main and its forks: `ozi session new|list|import|export|reload` and, in the terminal app, `/new`, `/fork`, `/clone`, `/resume`, `/tree`, `/import`, `/export`, `/reload`, `/name`, `ozi -c|-r|--session`. The terminal app also does Pi's slash pass-through and autocomplete, thinking display, tool expansion, `!`/`!!`, `/compact`, `/copy`, `/session`, `/model`, `/thinking`, `/settings`, `/scoped-models`, Pi's keys, themes and `keybindings.json`, footer usage, inline images and clipboard paste, queued-message restore and searchable pickers. `ozi -p` is Pi's print mode. Out of scope: `/login`/`/logout` (subscription; `ozi pi` covers Pi's other sign-ins), `/share`, `/trust`, `/bug`, `/changelog`, and extension components Pi's RPC mode cannot carry.
- Desktop: own identity (`~/.ozi`, `ozi` shim, Electron profile `ozi`, app id `com.ozi.app`); picks the saved remote server; Linux desktop E2E under Xvfb.

## Real-agent runs (Ubuntu server under systemd, real Opus main on the subscription, real workers)

- R1 (M1): main answered directly, delegated to real Codex, Claude and Pi workers; attachment, steer, queue and stop. Fixed: unusable Pi `default` model, duplicate card on retry, stopped job shown as Checking.
- R2 (M2): a real worker asked a question → card Needs you → `ozi answer` → the owning worker resumed → Ready.
- R3 (M3): real checks on every claim (done, superseded, needs_user; cost recorded); exact close → Done; stale close rejected as one-line `StaleEvent`.
- R4 (M4): a real schedule woke main, which delegated quietly and reported nothing; a real webhook POST woke main, which reported. Fixed: checker now judges usefulness against the originating request.
- R5 (M5): the user corrected an answer format; main logged it with the correction reference; the repair replayed the frozen case in bwrap, passed and shipped one data-root commit (`fix: repair …`).
- R6 (M6): the next turn answered in the repaired format ("Aconcagua (6,961 m)"); manual undo reverted the commit cleanly.
- Desktop (MacBook Pro, final build): the app paired with the Ubuntu server with the local environment off and showed main and the job cards. A message sent from the Pro made main delegate to a real Codex worker, which asked a multiple-choice question; answering on the card resumed it, the check passed, the card went Ready, main reported, and closing it moved it to Done. Fixed from this run: long briefs hid the job transcript, card reports showed raw markdown and overflowed on long code lines, the no-server screen was unstyled.

- R7 (M7): from the terminal app on Ubuntu and on the MacBook Air (`ozi` installed from the desktop's Settings, `ozi connect` to the Ubuntu server): main answered directly; a real Codex worker asked a multiple-choice question; the Needs-you line appeared, the answer was picked in `/jobs`, the worker wrote exactly `beta`, the check passed, main reported, and closing from the terminal moved the card to Done. Fixed from this run: main never received a worker's result when an earlier run's check had ended in needs_user or continue; `/jobs` truncated job titles.

- R8 (M8): on the Ubuntu server, `ozi pi mcp add` added an MCP server to main without restarting Ozi; on the next message real Opus main listed the new tool and called it itself.

- R9 (M9): against the live server with real Opus on the subscription, `ozi -p` answered, counted piped stdin lines and returned `--json`; `ozi session new` started its own Pi session that answered apart from main, `ozi main --thread` reached it and it remembered its reply after `ozi session reload`. In the terminal app `/new` answered, `/name` renamed it, `/export` wrote its Pi JSONL locally, `/clone` and `/tree` showed the fork, `/settings` opened in the fresh clone, and the picker deleted both sessions. Fixed from this run: `/settings` needed a live Pi process; it now edits main's Pi settings directly (`ozi settings`), and `/name` works before a session's first turn.

## Limits

- The Pro's outbound Tailscale TCP fails (two Tailscale daemons run there), so its app reaches the server through an SSH tunnel over Tailscale via the Air.
- Once during the Pro run, main's conversation stayed scrolled to the top after a job report; three further attempts (plain turn, server restart, delegated job) did not reproduce it.
- The MacBook Pro went offline (asleep) before R7's Mac run, so that run used the MacBook Air with the same final build.
- Repair replays still run a sealed Pi: a replayed main turn cannot use Pi's built-ins or main's own MCP servers, for the original and the candidate alike.
- External to-dos are verified with fake MCP sources; the real Apple Reminders source on the Air returned an empty list.
