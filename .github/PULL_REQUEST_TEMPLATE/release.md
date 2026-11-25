<!-- Title: `release: vX.Y.Z`. Change only the versions, CHANGELOG.md and version mentions in docs (AGENTS.md → Releases). -->

## Release vX.Y.Z

Stage: <!-- alpha | beta | rc | stable | patch --> (see the commits-and-releases skill → Release channels). Why this stage:
Changes since the last stage: <!-- none | list -->. Known issues (beta/rc): <!-- none | list -->

## Gates

- [ ] `main` CI is green at the base of this PR
- [ ] `version` agrees in `package.json` and both plugin manifests; `bun scripts/release-notes.ts --check` passes
- [ ] `bun scripts/release-notes.ts vX.Y.Z` prints the notes (pasted below)
- [ ] Optional install check: `bun pm pack && scripts/release-smoke.sh capcomd-X.Y.Z.tgz X.Y.Z`
- [ ] Live e2e (`scripts/mac-subagents-e2e.sh`): <!-- E2E PASS, run by a maintainer | waived by a maintainer (say who and why) -->; e2e repos deleted
- [ ] Contract (`harness.v1`) changes since the last release are in the changelog as **Breaking:** or none

## After merge (maintainer or agent asked to release)

- [ ] Main CI on the merge commit is green, then tag that exact commit and push only the tag
- [ ] Release workflow green; assets listed and installed from the published artifact in a fresh `HOME`
- [ ] Release URL, npm version and Homebrew tap result reported on this PR

## Release notes

```
<!-- output of bun scripts/release-notes.ts vX.Y.Z -->
```
