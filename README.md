# Ozi

Talk to one main agent. It delegates work to Codex, Claude or Pi workers and keeps every job on a card. Mistakes get tested fixes.

The server requires Linux, Node.js 24.13.1+, pnpm, Git and bubblewrap (`bwrap`). Install Pi and Claude Code for main, and Codex for the default worker. Sign in through the provider CLIs. Main uses the bundled pi-claude-bridge and your Claude Code subscription; no `pi install` step is needed.

```sh
git clone https://github.com/JohanSardar/ozi-harness.git ozi-src
cd ozi-src
pnpm install
pnpm vp run --filter ozi build
node apps/server/dist/bin.mjs serve --json
```

Startup seeds a missing or empty data root at `~/ozi` with packaged defaults. `system.md` holds main's system prompt, `skills/` holds skills, and `protected/` holds rules self-repair cannot change. Choose another root with `--data-root` or `OZI_DATA_ROOT`. Server state lives separately in `~/.ozi` (`--home` or `OZI_HOME`).

Run CLI commands with `node apps/server/dist/bin.mjs <command> --json`; `--help` lists them. `pair` prints a pairing URL for Settings → Connections in the desktop app. For another machine, serve with `--host 0.0.0.0` and use the server's reachable address in that URL.

See [SPEC.md](SPEC.md), [feature coverage](features.yaml) and [development rules](AGENTS.md).

Forked from [T3 Code](https://github.com/pingdotgg/t3code) v0.1.1. Ozi is [MIT](LICENSE); dependencies retain their [own licenses and notices](THIRD_PARTY_NOTICES.md).
