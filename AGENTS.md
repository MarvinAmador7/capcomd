# Working on capcomd (for coding agents)

Read [DEVELOPMENT.md](DEVELOPMENT.md) for the layout, tests and state directories. This file is the short list of
rules an agent must follow in this repository; `CLAUDE.md` imports it.

## Changes

- Every change reaches `main` through a pull request with green CI, unless a maintainer explicitly asks you to
  push to `main`. Never force-push `main`.
- Before you say a change is done: `bun run typecheck`, `bun run test:fast`, and the suites for what you touched
  (`bun run test:scenarios` for anything under `src/`; see DEVELOPMENT.md → Testing). Report failures as failures.
- Anything a user would notice (a command, a flag, output, behavior, a fix, a removal) gets a line under
  `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), in the same commit or PR. Write it for users: what changed and
  how to use it, not how it was implemented. Mark breaking changes with **Breaking:** and say what to do instead.
  Internal refactors and test-only changes don't need an entry.
- Don't touch `version` in `package.json` outside a release (CI checks it against the changelog).
- Never commit secrets, keys, logins or anything under `.relay/`, `.traces/` or `~/.capcomd`.

## Releases

Releases follow [Semantic Versioning](https://semver.org) and a [Keep a Changelog](https://keepachangelog.com)
style changelog, and are built only by CI from a tag (`.github/workflows/release.yml`). Cut one only when a
maintainer asks for it.

Version numbers, while capcomd is 0.x: breaking changes or notable features bump the minor (0.3.0 → 0.4.0); fixes
only bump the patch (0.3.0 → 0.3.1). Release candidates are `X.Y.Z-rc.N` and publish as prereleases.

Procedure:

1. Start from an up-to-date `main` with green CI. Read the `## Unreleased` entries and pick the version from them.
2. In one PR (or commit, if asked to push to `main`) titled `release: vX.Y.Z`, change only:
   - `package.json` `version` to `X.Y.Z`;
   - `CHANGELOG.md`: rename `## Unreleased` to `## X.Y.Z (YYYY-MM-DD)` (today's date), add a one-line summary
     under it, and put a new empty `## Unreleased` above it;
   - version mentions in the docs, if any pin one.
3. `bun scripts/release-notes.ts vX.Y.Z` must print the notes. Optionally run the install check locally:
   `bun pm pack && scripts/release-smoke.sh capcomd-X.Y.Z.tgz X.Y.Z`.
4. The live end-to-end run (`scripts/mac-subagents-e2e.sh`) needs a maintainer's boxd, GitHub and agent logins:
   ask the maintainer to run it, or to waive it, and say which happened in the PR.
5. After the release commit is on `main` and its CI passed, tag that exact commit and push only the tag:
   `git tag -a vX.Y.Z -m "capcomd X.Y.Z" <sha> && git push origin vX.Y.Z`.
6. Watch the Release workflow (`gh run watch`) and report the release URL and the npm version
   (`npm view capcomd@X.Y.Z version`), or the failing job and its log.

Never:

- create, edit or upload GitHub releases or their files by hand: the workflow is the only publisher, and re-running
  it (Actions → Release → Run workflow, with the tag) updates the release in place;
- move, delete or re-push a published tag: fix forward with a patch release;
- `npm publish` by hand, `npm unpublish`/`npm deprecate`, or change npm dist-tags: the workflow publishes, and
  anything else on npm is a maintainer's decision;
- change `LICENSE`, the package name, or anything in `publishConfig` without a maintainer's explicit decision;
- tag a commit that isn't on `main` or whose CI didn't pass (the workflow refuses the first, the second is on you).
