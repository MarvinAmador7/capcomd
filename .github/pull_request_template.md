## What and why

<!-- What changes for users or contributors, and why. Link issues. -->

## Checklist

- [ ] `bun run typecheck` and `bun run test:fast` pass; `bun run test:scenarios` too if `src/` changed
- [ ] User-visible change? A note in `changes/<slug>.md` (`# CHANGELOG`; **Breaking:** marked, with what to do instead). Spec change? Its §18 row in the note's `# Spec`
- [ ] Docs updated where behavior changed (README, STATUS.md, DEVELOPMENT.md)
- [ ] `package.json` version unchanged (it changes only in a `release: vX.Y.Z` PR, see AGENTS.md)
