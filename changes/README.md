# Change notes

Each pull request that users would notice, or that changes the plugin spec, adds one file here instead of editing
`CHANGELOG.md` or the spec's §18 table. Parallel pull requests then never conflict over those lines.

Name the file after the change, in lowercase (`plugin-api-routes.md`). It has one or both sections:

```markdown
# CHANGELOG

- Plugins can serve their own API routes at `/v1/x/<plugin>/<path>`.
- **Breaking:** `capcomd plugins list` no longer prints … ; use … instead.

# Spec

With plugin API routes: what changed in the spec, as one §18 row (no `|`).
```

The `# CHANGELOG` bullets are written for users, as AGENTS.md says. The `# Spec` text becomes a §18 row; its number
and date are given when the notes are folded, so refer to the change by what it does, not by a row number.

`bun scripts/changes.ts` lists the pending notes and `--check` validates them (CI runs it). At a release,
`bun scripts/changes.ts fold` moves every note into `CHANGELOG.md` under `## Unreleased` and into §18, and deletes the
files (AGENTS.md → Releases, step 2).
