#!/usr/bin/env bun
// Release notes for a tag, from CHANGELOG.md: `bun scripts/release-notes.ts v0.3.0 [owner/repo]`.
// Checks that the tag is `v` + package.json's version and that CHANGELOG.md has a dated section for it (not just
// "Unreleased"); prints that section with relative links pointed at the tag, plus install lines. Exits 1 with the
// reason otherwise. With GITHUB_OUTPUT set (in Actions), also writes version, title and prerelease there.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fail = (m: string): never => { console.error(`release-notes: ${m}`); process.exit(1); };

const tag = process.argv[2] ?? fail("usage: bun scripts/release-notes.ts vX.Y.Z [owner/repo]");
const repo = process.argv[3] ?? process.env.GITHUB_REPOSITORY ?? "MarvinAmador7/capcomd";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (tag !== `v${pkg.version}`) fail(`tag ${tag} doesn't match package.json version ${pkg.version} (expected v${pkg.version})`);

const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");
const esc = pkg.version.replace(/\./g, "\\.");
const start = lines.findIndex((l) => new RegExp(`^## ${esc}( |$)`).test(l));
if (start < 0) fail(`CHANGELOG.md has no "## ${pkg.version} (date)" section (move the Unreleased entries under one)`);
const heading = lines[start]!;
if (!/\(\d{4}-\d{2}-\d{2}\)/.test(heading)) fail(`CHANGELOG.md heading "${heading}" has no (YYYY-MM-DD) date`);
const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
if (!body) fail(`CHANGELOG.md section ${pkg.version} is empty`);

// Relative links (`[STATUS.md](STATUS.md)`, `docs/…`) would resolve against the releases page: point them at the tag.
const notes = body.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, p) => `](https://github.com/${repo}/blob/${tag}/${p})`);
const tgz = `capcomd-${pkg.version}.tgz`;
const install = `### Install

Needs [Bun](https://bun.sh) ≥ ${String(pkg.engines?.bun ?? ">=1.4").replace(/^>=\s*/, "")}.

\`\`\`bash
bun add -g git+ssh://git@github.com/${repo}.git#${tag}
# or from this release's package:
gh release download ${tag} --repo ${repo} --pattern '${tgz}' && bun add -g ./${tgz}
capcomd setup
\`\`\`

\`${tgz}.sha256\` holds the package's SHA-256.`;
console.log(`${notes}\n\n${install}`);

const preview = pkg.private === true || pkg.version.includes("-");
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${pkg.version}\ntitle=capcomd ${pkg.version}${preview ? " (private preview)" : ""}\nprerelease=${preview}\n`);
}
