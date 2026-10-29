# Ozi

Agent runtime with a desktop app: one main agent the user talks to, which delegates work to workers and keeps every job on a card. Forked from T3 Code v0.1.1. Read `SPEC.md` first; `features.yaml` maps requirements to modules, CLI and scenarios.

## Rules

- Minimal: fewest words, least code. No code comments, no TODOs, no placeholders, no disabled code.
- Cutting removes the whole vertical slice: callers, schema, UI, dependencies, tests.
- Tests are E2E only (`e2e/`): real server, SQLite, files, git, bwrap, web client and `ozi` CLI. Fake only provider transports (`e2e/fakes`), the clock and external MCP. Await state with `ozi wait`, never sleeps. Run a feature's scenarios while building it the first time; CI runs only typecheck and lint. A unit test needs a written reason why E2E can't reach it.
- Name each E2E test by its SPEC scenario ID first, e.g. `it("m1.fresh-install", …)`.
- Keep `SPEC.md` and `features.yaml` current in the same change as the code. `node scripts/features.ts check <milestone>` must pass for finished milestones.
- Everything goes through the `ozi` CLI (`--json`). If something can't be done with it, extend it; no one-off scripts.
- Correction ladder for every mistake: make it impossible (types, structure), else a lint or check, else prompt or skill text.
- No personal data, paths, accounts or secrets in the repo.
- Keep MIT notices for T3 Code, Pi and Firstmate.

## Safety

- Never kill by pattern (`pkill -f`, `pgrep | kill`). Kill only PIDs you started.
- Never touch `~/.t3`, `~/.ozi` or `~/ozi`: they are live installs. Tests use temp homes and temp data roots.
- Never set `VITE_HTTP_URL` or `VITE_WS_URL`.

## Commands

- `pnpm install`; `vp` is `node_modules/.bin/vp`.
- E2E: `vp test run --root e2e`. Targeted typecheck: `vp run --filter <pkg> typecheck`. Lint: `vp lint <paths>`.
- Server code is Effect: see `docs/internals/effect-services.md` and `.repos/effect-smol/LLMS.md`.
