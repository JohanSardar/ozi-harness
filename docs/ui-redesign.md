# UI redesign

The desktop and web client move to T3 Code v0.1.5's interface with an Ozi inbox. A clickable prototype with fake data comes first; the real build follows it.

## Base

- Port the client onto upstream T3 Code v0.1.5's own components: sidebar, chat view, work log, composer, attachments (images, video, files), queued runs, settings window, themes. Copy their code; remove projects, git, worktrees, diffs and devices.
- Rename `t3` to `ozi` in the MCP server name, tool names (`t3_thread_*`, `t3_queue_*`, …) and descriptions, which also lose T3 examples and project wording.
- Nothing may sit under the macOS window buttons; the sidebar header keeps their inset clear.

## Layout

Three columns: chats, conversation, inbox.

### Chats (left)

- Search, New chat, pinned chats, then recent chats. Each row: title, relative time, a dot for working or needs you.
- No folders, projects or bots. Settings and the avatar sit at the bottom.

### Conversation (center)

- As T3: user messages are bubbles on the right; assistant text is plain and full width, centered in a 46rem column.
- Tool work folds into one "Worked for 1m 20s" row; it expands to steps, and each step to its details.
- Delegated jobs show as inline chips that open their ticket or live job.
- Hovering or selecting assistant text offers Reply; the quote sits above the composer and goes with the message.
- Composer as T3: one composer for new and existing chats, attachments, model and thinking picker. While the bot works, Enter steers and ⌘Enter queues; Stop shows when the composer is empty. Queued messages sit right-aligned above the composer with send now, edit and remove.

### Inbox (right)

- One inbox for every chat, with Inbox and Archive tabs. A collapsed "Working · n" row lists running jobs with one live line each.
- A ticket is anything the agent judges needs acknowledgement or a response: a worker's question or approval, a secret or login, a finished result, a failure or blocked job, or something main thinks the user should see. Main may end any turn with one; small talk gets none.
- A ticket shows its source chat, a title, one bold line saying what the user needs to do, a few lines of context that convey everything, numbered quick options (keys 1–3) when there is a choice, a reply box, and Got it.
- Expand opens the ticket in a window over the app, like T3's settings: full context, the job's transcript link and a reply box at the bottom. Clicking outside closes it; sending closes it.

## Tickets

- Quick options and Allow/Deny answer the worker directly and add a one-line note to the chat.
- A typed reply, from the card, the window or the archive, always goes into the chat the user is in, never an old thread. It shows a "↩ ticket" quote. Main receives the ticket text, a fuller summary of its origin, a link to that session's transcript and the IDs it needs to read more.
- A ticket clears when answered, replied to, acknowledged with Got it, or acknowledged in chat. Main sees open tickets (ID, title, one line) every turn, has tools to post and close them, and closes one when a chat message acknowledges it; the chat shows "✓ Closed: ‹title›".
- Cleared tickets go to the archive with the message that cleared them. The archive is searchable and replyable.
- New tickets raise a desktop notification and a dock badge; both can be turned off in Settings → General.

## Look

- T3's design, slightly squarer: 6–8px corners. Small monospace capitals for labels and statuses, as in hyperfocus (agentbox).
- T3's light and dark modes, preset themes and advanced theme editor (background, surface, raised surface, overlay, text, muted text, border, input, accent, message surface, sidebar colors, status colors).
- Settings is T3's overlay window with search, keeping General, Appearance, Chat, Keybindings, Agents (Providers, Browser, Scheduled tasks), Connections (Environments, Sharing & access), Maintenance and About.

## Later

Multiple bots (personas, each its own harness) in the sidebar, an animated bot avatar, mobile layout.
