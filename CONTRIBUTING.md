# Contributing to capcomd

Thanks for helping. Bug reports, fixes, docs and design discussion are all welcome.

## Before you start

- **Bugs**: open an issue with what you ran, what happened and what you expected (the template asks for the
  details that matter: version, sandbox, `capcomd doctor` output). Security problems go through
  [SECURITY.md](SECURITY.md), not issues.
- **Features and larger changes**: open an issue first, so we can agree on the shape before you write the code.
  Design decisions are recorded as ADRs in [`docs/`](docs); a change that alters one should say so.
- Small fixes (typos, docs, an obvious bug with a test) can go straight to a pull request.

## Development

[DEVELOPMENT.md](DEVELOPMENT.md) covers setup, the code layout, where state lives and the test suites. In short:

```bash
bun run setup          # Bun ≥ 1.4 (CI uses the version in .bun-version)
bun run typecheck
bun run test:fast      # about a minute
bun run test:scenarios # anything under src/
```

You don't need boxd, GitHub or agent accounts for these: the tests use a fake sandbox and scripted agents. The
live end-to-end script (`scripts/mac-subagents-e2e.sh`) needs all three; maintainers run it before releases.

## Pull requests

- One topic per pull request, with tests for what changed and green CI.
- A user-visible change gets a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), written for users.
  Mark breaking changes **Breaking:** and say what to do instead.
- Update the docs that describe the behavior you changed (README, STATUS.md, DEVELOPMENT.md, the ADR).
- Leave `version` in `package.json` alone: it changes only in release commits.
- Match the surrounding code: its naming, its comment density, its error messages (they say what to do next).

Coding agents working in this repository follow [AGENTS.md](AGENTS.md), which has the same rules plus the release
procedure.

## Releases

Maintainers cut releases from tags; CI tests, packs, publishes to npm and creates the GitHub release. See
DEVELOPMENT.md → Cutting a release.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), the license of
this project.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
