# Building and verifying

How a feature gets built and checked the first time. Delegation prompts carry these rules; `AGENTS.md` does not.

## Dev loop

- Each agent works in its own git checkout or worktree. `pnpm dev` starts that checkout's own server and web app with live reload: home `<checkout>/.ozi`, data root `<checkout>/.ozi/data-root`, ports derived from the checkout path. Nothing touches `~/.ozi` or `~/ozi`.
- Measured: the web app is ready in about 1.3 s and the server listens in about 2.4 s. Web edits apply instantly; server edits restart the server in about 2 s.
- Sign in with `node apps/server/src/bin.ts pair --home .ozi --json` (about 0.4 s) and open the URL on the checkout's web port.
- No production or desktop builds except for releases.

## Speed

- The inner loop takes seconds: typecheck and lint only what changed (`vp run --filter <pkg> typecheck`, `vp lint <paths>`), run one E2E file.
- Any step that takes more than about 10 s is investigated: find why and speed it up (cache, watch mode, a narrower command), or report why it can't be.
- Real-model turns are the slow part. Run behaviour checks in parallel across checkouts instead of one after another.

## Verifying a new feature

1. **E2E**: the feature's scenarios in one test file, with fake providers.
2. **Real behaviour**: open the dev app in a browser, pair, and give real Ozi (Pi with Opus on the subscription) the scenario through the composer. Check the reply, the inbox and the workers against what the scenario expects, take screenshots, and attach them to the PR. Agents use T3's shared browser tools (open, click, type, screenshot, read the page; one tab per agent, watchable in the browser panel) or Playwright.
3. **Second look**: for bigger features, another agent reruns the scenario before merging.
4. **Desktop-only details** (window buttons, dock badge): the GUI repo's T3 v0.1.5 desktop dev mode under a virtual display, driven by Playwright's Electron support; the Mac gives the final look. Not yet verified: today's repo has no desktop dev mode.

## CI

Typecheck and lint only.
