# UI redesign

Ozi splits into a GUI that runs any harness and the Ozi harness. The GUI moves to T3 Code v0.1.5's interface with an Ozi inbox. A clickable prototype with fake data comes first; the real build follows it.

## Repositories

- **GUI, `ozi`**: a fresh fork of T3 Code v0.1.5 with the desktop app, web app, server, `ozi` CLI and terminal app. It keeps every T3 provider, including ACP agents; any chat can use any harness, and Ozi is the default. Its MCP server gives every harness the same tools: HTML replies, the shared browser, threads, delegation, schedules, attachments and the inbox.
- **Harness, `ozi-harness`**: this repository, renamed. Ozi's main agent is Pi plus an Ozi package with `system.md`, `adhd.md`, skills, self-repair, completion checks and delegation behaviour. Harness-only commands are `ozi-harness …`. The GUI runs it through T3's Pi adapter; an ACP entry point comes later.
- The split is the first step of the rebuild. The live server keeps the current build until the new one matches it.

## Base

- Port the client onto T3 Code v0.1.5's own components: sidebar, chat view, work log, composer, attachments (images, video, files), queued runs, settings window, themes. Copy their code; remove projects, git, worktrees, diffs and devices.
- Rename `t3` to `ozi` in the MCP server name, tool names (`t3_thread_*`, `t3_queue_*`, …) and descriptions, which also lose T3 examples and project wording.
- Nothing may sit under the macOS window buttons; the sidebar header keeps their inset clear.
- No pills, coloured dots or monospace capital labels. Working shows as a thin spinner; labels are plain sentence case.

## Layout

Three columns: chats, conversation, inbox.

### Chats (left)

- Search, New chat, then sections Needs you, Working, Pinned and Recent; each chat appears once, in the first that fits. Rows show the title and the time, or a spinner while working.
- No folders, projects or bots. Settings and the avatar sit at the bottom.

### Conversation (center)

- As T3: user messages are bubbles on the right; assistant text is plain and full width, centered in a 46rem column.
- The top bar shows the chat title and, while it works, a spinner with the elapsed time.
- Tool work folds into one "Worked for 1m 20s" row; it expands to steps, and each step to its details.
- A delegated job shows as a line "↳ ‹job› · waiting on you" that opens its ticket.
- Hovering or selecting assistant text offers Reply; the quote sits above the composer and goes with the message.
- Composer as T3: one composer for new and existing chats, attachments, model and thinking picker. While the agent works, Enter steers and ⌘Enter queues; Stop shows when the composer is empty. Queued messages sit right-aligned above the composer with send now, edit and remove.

### Inbox (right)

- One inbox for every chat, with Inbox and Archive tabs.
- Tickets are grouped under Decide (questions and approvals), Do (things only the user can do, such as a BankID login), Review (finished work) and Read (nothing to do), each with a count. The heading is the only type marker; rows carry no icons.
- A row shows the ticket title and its chat and age, and opens in place: one bold line saying what the user needs to do, the context, numbered choices (keys 1–3) when there is a choice, a reply box, Got it and Open details. The first ticket starts open; clearing one opens the next.
- Open details shows the ticket in a window over the app, like T3's settings: the full context, details, choices, the session transcript and job, and a reply box at the bottom. Clicking outside closes it; sending closes it.
- Running jobs sit in a collapsed Working section at the bottom.

## Tickets

- Every agent the GUI runs always has `ticket_create`, `ticket_update`, `ticket_close` and `ticket_list` from the GUI's MCP server. Their descriptions tell delegated workers to use them only when their task explicitly asks. Main files tickets from worker results unless it explicitly delegates ticket filing. The GUI stores and displays tickets and never creates one itself; tickets are structured data, not HTML.
- A ticket has a visible part (group Decide, Do, Review or Read; a short title; one line saying what the user needs to do; a 2–4 line summary), a clickable part (up to about four choices, each a label and a one-line detail) and an in-depth part (full markdown detail, attachments and HTML pages). The GUI attaches the session transcript, chat, job, worker and message IDs from the calling session itself.
- A ticket is anything that needs the user's answer or acknowledgement: a question, an approval, something only the user can do, a finished result, a failure, or something the user should see. Small talk gets none.
- An inbox plugin per harness adds a stop hook to top-level chats only. Delegated workers and other subagents, identified by their parent relationship on every provider, get no inbox hook or inbox prompting and run as plain T3 subagents with the same settings. Completion checks are unchanged. When a top-level chat ends a turn, the hook forks its session on the same harness and model with full context and prompts the fork: file a ticket, with everything in it, for anything from this turn that needs the user's answer or acknowledgement; close the listed open tickets the user's last message acknowledged; file nothing if nothing fits. The main session's history and behaviour are untouched and the user can reply at once; tickets appear when the fork finishes. Forks do not run the hook. Claude Code uses its Stop hook with `--resume --fork-session`, Codex its `stop` hook with `thread/fork`, and Pi a turn-end extension with `--fork`; the Ozi harness ships the plugin in its package. Harnesses without hooks use the tools without the check. The check shows as one quiet "Inbox check · 1 filed" step in the work log.
- Choosing an option answers the asking agent directly and adds a one-line note to the chat.
- A typed reply, from the row, the window or the archive, always goes into the chat the user is in, never an old thread. It shows a "↩ ticket" quote. The agent receives the ticket text, a fuller summary of its origin, a link to that session's transcript and the IDs it needs to read more.
- A ticket clears when answered, replied to, acknowledged with Got it, or closed by an agent after the user acknowledged it in chat; the chat then shows "✓ Closed: ‹title›".
- Cleared tickets go to the archive with what cleared them. The archive is searchable and replyable.
- New tickets raise a desktop notification and a dock badge; both can be turned off in Settings → General.

## Look

- T3's design, slightly squarer: 6–8px corners.
- T3's light and dark modes, preset themes and advanced theme editor (background, surface, raised surface, overlay, text, muted text, border, input, accent, message surface, sidebar colors, status colors).
- Settings is T3's overlay window with search, keeping General, Appearance, Chat, Keybindings, Agents (Providers, Browser, Scheduled tasks), Connections (Environments, Sharing & access), Maintenance and About.

## Later

Multiple bots (personas, each its own harness) in the sidebar, an animated bot avatar, mobile layout.
