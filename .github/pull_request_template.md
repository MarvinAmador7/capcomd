## What and why

<!-- What changes for users or contributors, and why. Link issues. -->

## Checklist

- [ ] `bun run typecheck` and `bun run test:fast` pass; `bun run test:scenarios` too if `src/` changed
- [ ] User-visible change? A line under `## Unreleased` in CHANGELOG.md (**Breaking:** marked, with what to do instead)
- [ ] Docs updated where behavior changed (README, STATUS.md, DEVELOPMENT.md)
- [ ] `package.json` version unchanged (it changes only in a `release: vX.Y.Z` PR, see AGENTS.md)
