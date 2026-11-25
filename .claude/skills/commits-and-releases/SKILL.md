---
name: commits-and-releases
description: capcomd's standard for commits, pull requests, changelog entries and cutting a GitHub release (rc and stable). Use when committing, opening or merging a PR, writing a CHANGELOG line, or when a maintainer asks to cut, tag or ship a release.
---
# Commits, PRs and releases in capcomd

[AGENTS.md](../../../AGENTS.md) is the source of truth for the rules and [DEVELOPMENT.md](../../../DEVELOPMENT.md) →
Cutting a release for the workflow's details. This skill is the checklist; if it disagrees with them, they win (and fix
this file in the same PR).

## Commits

- Subject: `area: imperative summary`, lowercase after the colon, no trailing period, 72 characters or fewer.
  `area` is what a reader would grep for: `menubar`, `harness`, `docker`, `setup`, `docs`, `ci`, `test`, `design`.
  Use `area(sub): ...` only when one area has clear parts (`design(menubar): ...`). Release commits are exactly
  `release: vX.Y.Z`.
- Body (when the why isn't obvious from the diff): blank line, then what was wrong or why this approach, checked
  facts with dates (`checked live 2026-10-24`), and what the reader should do differently. The subject says what; the
  body says why. Don't paste the whole story into the subject.
- One topic per commit. Don't mix a refactor with a behavior change.
- Never commit secrets, keys, logins, or anything under `.relay/`, `.traces/`, `~/.capcomd`, nor `.trace` files.
- Commit only when asked, and never to `main` directly unless a maintainer says to. Never force-push `main`.
- End the message with the attribution trailer the session gives you.

## Branches and pull requests

- Branch from up-to-date `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `design/<topic>`.
- One topic per PR, titled like a commit subject. Fill in `.github/pull_request_template.md` ("What and why" plus the
  checklist); add how it was tested (commands run and results, failures included).
- Before saying it's done: `bun run typecheck`, `bun run test:fast`, and for anything under `src/`
  `bun run test:scenarios`. Report a failure as a failure.
- Anything a user would notice gets a line under `## Unreleased` in `CHANGELOG.md` in the same PR (below).
- Merge only with green CI. If another PR merged since your last green run, merge `main` into yours and re-run CI
  first: PRs that pass alone have broken `main` together.
- Don't touch `version` in `package.json` or the plugin manifests outside a release PR.

## Changelog entries

- Under `## Unreleased`, one bullet per user-visible change (command, flag, output, behavior, fix, removal), written
  for the user: what changed and how to use it, not how it's built. Lead with the command or surface.
- Breaking changes start with **Breaking:** and say what to do instead.
- Internal refactors, tests and CI-only changes get no entry.

## Release standard (CLI and apps)

- **Lockstep versioning.** One `vX.Y.Z` tag, one `CHANGELOG.md`, one GitHub release for everything capcomd ships:
  the npm package, the single executables, the Homebrew formula, and the macOS menubar/desktop app (`apps/menubar`).
  `capcomd tui` and the canvas ship inside the CLI. The CLI and apps talk over the `harness.v1` contract, so
  compatibility is the contract version, never a matrix of app and CLI versions. A change to the contract is a
  **Breaking:** entry and a minor bump while 0.x.
- **Every artifact carries the release version** and says so (`capcomd --version`, the app's About, the plugin
  manifests); the workflow checks they agree. A release that can't prove that doesn't ship.
- **Release candidates first** for any minor bump (stages and when to use each: "Release channels" below):
  `vX.Y.0-rc.N`, a prerelease on GitHub and `next` on npm, no Homebrew update. The stable release is the same
  content with no code changes since the last rc (say so in its changelog summary, as 0.6.0 did); anything that
  needs a code change is a new rc.
- **Trust, for an open-source release anyone can install:**
  - every artifact has a `.sha256`; npm publishes with provenance;
  - the app is ad hoc signed and not notarized until a Developer ID exists (never use someone else's Apple
    Development cert): the release notes and README say how to open it past Gatekeeper, and notarization is added the
    day a Developer ID is available;
  - required, status noted below: GitHub build-provenance attestations for each binary and the app
    (`gh attestation verify <file> --repo MarvinAmador7/capcomd`) and an SBOM attached to the release.
- **Supported versions:** fixes go to the latest release; a security fix may also go to the previous minor through a
  `release/0.N` branch (below). `SECURITY.md` says which versions are supported.
- **Hotfix to an older minor:** branch `release/0.N` from that minor's last tag, land the fix by PR into it, release
  `0.N.(P+1)` from that branch with the same PR gates, then forward-port the fix and its changelog entry to `main`.
  The workflow's "tag is on `main`" check needs a `release/*` allowance before this is used; until then, cut a patch
  from `main`.

## Release channels: when to flag alpha, beta, rc or stable

The stage is part of the version (`X.Y.Z-alpha.N`, `-beta.N`, `-rc.N`, then plain `X.Y.Z`) and the tag (`v…`). The
counter restarts at 1 for each stage; semver orders them alpha < beta < rc < stable, so never go backwards (after a
beta, no new alpha for the same `X.Y.Z`; start `X.Y.(Z+1)` or the next minor instead).

| Stage | Say it when | Promise to users | Gate before tagging |
|---|---|---|---|
| **alpha** | A new surface or contract is still moving: commands, flags, event shapes, app screens or `harness.v1` may change or break between alphas. Use it to get early feedback. | None. Expect breakage; don't build on it. | CI green, release-smoke. E2E optional. |
| **beta** | The version's features are all in and its CLI, contract and app behavior are frozen except for fixes. Known issues are listed in the changelog summary. | Usable by outside testers; changes are fixes only, plus a **Breaking:** entry if a fix must break something. | CI green, smoke, and the live e2e run or waived by a maintainer. |
| **rc** | You'd ship this exact content as stable. No known blocking bug; only fixes since the beta (or since the last rc). | Same as stable unless someone finds a blocker. | Full release gates (below), e2e passed or waived. |
| **stable** | The last rc had no code change since, and its testing found nothing blocking. | Supported and recommended; `latest` on npm, Homebrew updated. | Full release gates; changelog summary says "stable release of X.Y.Z-rc.N, no code changes since". |

How to choose, in order (stop at the first that fits):
1. Fix-only change on a released minor → **patch, straight to stable** (`0.7.1`); add an rc only if the fix touches the
   engine, verification, merge, security or the contract.
2. Minor bump (new feature, **Breaking:**, contract change) → at least one **rc**; use **alpha/beta** first when the
   change is large, spans CLI and app, or changes `harness.v1`.
3. Unsure which stage → pick the earlier, less-promising one and ask the maintainer.
Never go to stable from an alpha or beta; stable always follows an rc of the same `X.Y.Z`. While capcomd is 0.x, even
a stable release is "early" (README); 1.0.0 is the maintainer's decision, never an agent's.

What the flag does in this repo today (`scripts/release-notes.ts`, `release.yml`): any version containing `-` is a
GitHub **prerelease** (not "latest"), is published to npm under **`next`** (stable under `latest`) and skips the
Homebrew formula. So alpha, beta and rc are all `next`, and `next` means "the newest prerelease of any stage": don't
promise users a stage-specific install command. Say the stage in the changelog heading summary line
(`Alpha: …`, `Beta: …`, `Release candidate: …`) and in the GitHub release title, which comes from the version.
Not yet in the pipeline (add before relying on it): per-stage npm tags (`alpha`/`beta`/`rc`), and app artifacts in
prereleases.

Flag these in the release PR: the stage and why it fits the table, what changed since the last stage, and for a beta
or rc, the known issues. If the work doesn't meet the stage's row, say so and propose the earlier stage rather than
shipping it under the later one.

**Status of the pipeline against this standard** (keep this list true; remove a line when it ships):
`release.yml` builds, tests, smokes and publishes the CLI (npm with provenance, four binaries, `.sha256`, Homebrew
formula). Not yet there: the menubar app build and Homebrew cask job, build-provenance attestations, the SBOM, the
version-agreement check for the app, and the `release/*` allowance. Say so in the release PR when a release goes out
without one of them; don't claim an artifact is attested or an app is released if the workflow didn't produce it.

## Cutting a release

Only when a maintainer asks. Open the release PR with
`gh pr create --template release.md` (`.github/PULL_REQUEST_TEMPLATE/release.md`) so the gates show on the PR. Built only by CI from a tag; never create or edit GitHub releases, `npm publish`, or
move/delete a published tag by hand. Fix forward with a patch.

1. **Pick the version.** Start from up-to-date `main` with green CI (`gh run list --branch main -L 3`). Read
   `## Unreleased`. While 0.x: breaking change or notable feature → minor bump; fixes only → patch. Release
   candidate: `X.Y.Z-rc.N` (publishes as a prerelease, npm `next`). Confirm the number with the maintainer.
2. **Release PR** titled `release: vX.Y.Z`, changing only:
   - `version` in `package.json`, `plugins/capcomd/.claude-plugin/plugin.json`,
     `plugins/capcomd/.codex-plugin/plugin.json`;
   - `CHANGELOG.md`: `## Unreleased` → `## X.Y.Z (YYYY-MM-DD)` (today), a one-line summary under it, and a new empty
     `## Unreleased` above;
   - docs that pin a version.
3. **Check locally:** `bun scripts/release-notes.ts --check` and `bun scripts/release-notes.ts vX.Y.Z` (must print
   the notes). Optional: `bun pm pack && scripts/release-smoke.sh capcomd-X.Y.Z.tgz X.Y.Z`.
4. **Live e2e** (`scripts/mac-subagents-e2e.sh`, `E2E PASS`) needs the maintainer's boxd, GitHub and agent logins:
   ask them to run it or waive it, and say which happened in the PR body. Delete the e2e repos afterwards.
5. **Merge** the release PR once CI is green. Wait for CI on the merge commit on `main`.
6. **Tag that exact commit, push only the tag:**
   `git tag -a vX.Y.Z -m "capcomd X.Y.Z" <sha> && git push origin vX.Y.Z`
   (the workflow refuses a commit not on `main`; CI having passed is on you).
7. **Watch** `gh run watch` on the Release workflow. Report: the release URL (`gh release view vX.Y.Z --json url`),
   the npm version (`npm view capcomd@X.Y.Z version`), and whether the `homebrew` job updated the tap (stable only),
   or the failing job with its log. On failure: fix on `main`, then re-run the workflow (Actions → Release → Run
   workflow, with the tag) for the same tag if nothing published, else cut X.Y.Z+1.
8. **Verify what shipped,** not just that the workflow went green: `gh release view vX.Y.Z --json assets` lists the
   expected files (package, four binaries, `.sha256`s, plus the app and attestations once the workflow builds them);
   install from the published artifact in a fresh `HOME` (`install.sh`, `brew install`, `npm i -g capcomd@X.Y.Z`) and
   run `capcomd --version`; for a stable release, check `latest` on GitHub and npm point at it.
9. **After a stable release on npm** the maintainer's standing preference: update the local install
   (`bun add -g capcomd@X.Y.Z`, check the Rivet pins, kickstart launchd, probe).

## Never

Force-push `main`; push to `main` without being asked; tag a commit that isn't on `main` or lacks green CI; move,
delete or re-push a published tag; hand-publish to npm or GitHub releases; change `LICENSE`, the package name or
`publishConfig` without a maintainer's decision; bump `version` outside a release PR.
