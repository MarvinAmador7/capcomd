#!/usr/bin/env bun
// Change notes: one file per change in changes/, folded into CHANGELOG.md and the plugin spec's §18 table at release.
// Parallel PRs used to edit the same CHANGELOG lines and number the same §18 row, so every merge made the others
// conflict; a file of its own per change never conflicts. Format (changes/README.md): a `# CHANGELOG` section of
// bullet lines and/or a `# Spec` section holding one §18 row's text.
//   bun scripts/changes.ts --check     every note parses (CI)
//   bun scripts/changes.ts             list the pending notes
//   bun scripts/changes.ts fold [--date YYYY-MM-DD]
//                                      append the notes' bullets under `## Unreleased`, the spec rows to §18 with the
//                                      next 1.0.x numbers and the date, and delete the notes (the release's first step)
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ChangeNote = { file: string; changelog: string[]; spec: string };

const NAME = /^[a-z0-9][a-z0-9.-]*\.md$/;

/** Parses one note. Throws with the reason when it isn't one. */
export function parseNote(file: string, text: string): ChangeNote {
  if (!NAME.test(file)) throw new Error(`${file}: name it <lowercase-slug>.md`);
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    const h = /^# (.+?)\s*$/.exec(line);
    if (h) {
      const key = h[1]!.toLowerCase();
      if (key !== "changelog" && key !== "spec") throw new Error(`${file}: unknown section "# ${h[1]}" (only "# CHANGELOG" and "# Spec")`);
      if (sections.has(key)) throw new Error(`${file}: "# ${h[1]}" appears twice`);
      sections.set(key, (current = []));
    } else if (current) current.push(line);
    else if (line.trim()) throw new Error(`${file}: text before the first section`);
  }
  const changelog = (sections.get("changelog") ?? []).join("\n").trim();
  const spec = (sections.get("spec") ?? []).join(" ").replace(/\s+/g, " ").trim();
  if (!changelog && !spec) throw new Error(`${file}: empty (give it a "# CHANGELOG" or a "# Spec" section)`);
  if (changelog && !/^- /.test(changelog)) throw new Error(`${file}: the CHANGELOG section is a list of "- " bullets`);
  if (spec.includes("|")) throw new Error(`${file}: the Spec section can't contain "|" (it becomes a table cell)`);
  return { file, changelog: changelog ? changelog.split("\n") : [], spec };
}

export function readNotes(dir: string): ChangeNote[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort().map((f) => parseNote(f, readFileSync(join(dir, f), "utf8")));
}

/** CHANGELOG.md with the notes' bullets appended at the end of `## Unreleased`. */
export function foldChangelog(changelog: string, notes: ChangeNote[]): string {
  const bullets = notes.flatMap((n) => n.changelog);
  if (!bullets.length) return changelog;
  const lines = changelog.split("\n");
  const start = lines.indexOf("## Unreleased");
  if (start < 0) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  let last = end;
  while (last > start + 1 && !lines[last - 1]!.trim()) last--;
  const body = last > start + 1 ? [...lines.slice(start + 1, last), ...bullets] : ["", ...bullets];
  return [...lines.slice(0, start + 1), ...body, "", ...lines.slice(end)].join("\n");
}

/** The spec with the notes' rows appended to the §18 table, numbered after its last 1.0.x row. */
export function foldSpec(spec: string, notes: ChangeNote[], date: string): string {
  const rows = notes.filter((n) => n.spec);
  if (!rows.length) return spec;
  const lines = spec.split("\n");
  const head = lines.indexOf("## 18. Changes");
  if (head < 0) throw new Error('the spec has no "## 18. Changes" section');
  let last = -1;
  for (let i = head + 1; i < lines.length && !/^## /.test(lines[i]!); i++) if (lines[i]!.startsWith("| ")) last = i;
  if (last < 0) throw new Error("§18 has no table");
  let n = Math.max(0, ...lines.slice(head, last + 1).map((l) => Number(/^\| 1\.0\.(\d+) \|/.exec(l)?.[1] ?? 0)));
  const added = rows.map((r) => `| 1.0.${++n} | ${date} | ${r.spec} |`);
  return [...lines.slice(0, last + 1), ...added, ...lines.slice(last + 1)].join("\n");
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const dir = join(root, "changes");
  const cmd = process.argv[2];
  let notes: ChangeNote[];
  try { notes = readNotes(dir); } catch (e) { console.error(`changes: ${(e as Error).message}`); process.exit(1); }
  if (cmd === "--check") {
    console.log(`changes: ${notes.length} pending note${notes.length === 1 ? "" : "s"} parse`);
  } else if (cmd === "fold") {
    const i = process.argv.indexOf("--date");
    const date = i > 0 ? process.argv[i + 1]! : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error("changes: --date is YYYY-MM-DD"); process.exit(1); }
    const cl = join(root, "CHANGELOG.md"), sp = join(root, "docs/spec/plugin-api.md");
    writeFileSync(cl, foldChangelog(readFileSync(cl, "utf8"), notes));
    writeFileSync(sp, foldSpec(readFileSync(sp, "utf8"), notes, date));
    for (const n of notes) rmSync(join(dir, n.file));
    console.log(`changes: folded ${notes.length} note${notes.length === 1 ? "" : "s"}`);
  } else if (!cmd) {
    for (const n of notes) console.log(`${n.file}: ${n.changelog.length} changelog line${n.changelog.length === 1 ? "" : "s"}${n.spec ? ", a spec row" : ""}`);
    if (!notes.length) console.log("changes: none pending");
  } else { console.error("usage: bun scripts/changes.ts [--check | fold [--date YYYY-MM-DD]]"); process.exit(1); }
}
