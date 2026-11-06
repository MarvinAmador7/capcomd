// `capcomd context lint` (ADR-025 §5.3, §11.1, step 2): what makes a repository's `.capcomd/context/` fit to land. It
// holds items only (`memory/**.md`, `facts/**.md`, and OKF's reserved `index.md` and `log.md`); each item has
// frontmatter that parses, with an `id` and a `type` and well-formed lifecycle fields; ids are unique, and against a
// base (`--base`) never change and never disappear (an item is deprecated, not deleted); supersession is reciprocal
// and acyclic; no file holds a secret (the seeded scan, ./scan.ts, the one capture uses); every `outcomes[]` id of an
// item the change touches is a passed verify or a landed merge of the run (`--run`); and `index.md` is the one lint
// writes from the items' frontmatter (`--fix` rewrites it). Warnings don't fail it: a stale item, a long description,
// a large body, a body that reads like an instruction (for the reviewer, §8). Pure over the files it is given; the
// command (src/plugins/context.ts) reads them from the checkout. Step 3 runs it as a check on a consolidator's branch.
import { lstatSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { Outcome } from "../../packages/plugin/src/context-layer";
import { unmark } from "../subagents/results";
import { CONTEXT_DIR, MEMORY_MAX_BYTES, MEMORY_MAX_FILES, METHODS, STATUS, frontmatter, instant } from "./memory";
import type { ScanHit } from "./scan";

export const INDEX_FILE = `${CONTEXT_DIR}index.md`;

/** A file under `.capcomd/context/`, its path from the repository's root; `text` null when it can't be read as text. */
export interface LintFile { path: string; text: string | null; link?: boolean }

export type LintRule =
  | "not-an-item" | "unreadable" | "frontmatter" | "field" | "duplicate-id" | "id-changed" | "deleted" | "supersession"
  | "secret" | "outcome" | "index" | "stale" | "description" | "large" | "instruction";
export interface LintProblem { file: string; rule: LintRule; message: string }

export interface LintInput {
  files: LintFile[];
  /** The same directory at the base the change is judged against: ids never change and items are never deleted. */
  base?: LintFile[] | null;
  scan: (text: string) => ScanHit | null;
  /** With a run: whether an outcome is a passed verify or a landed merge of it. */
  outcome?: ((o: Outcome) => boolean) | null;
  /** `--fix`: index.md is about to be written, so an out-of-date one isn't a problem. */
  fix?: boolean;
  /** Bodies over this many bytes are flagged (the router's `itemBytes`). */
  itemBytes?: number | null;
  /** Descriptions over this many characters are flagged (the brief's `descriptionChars`). */
  descriptionChars?: number | null;
  now?: number;
}

export interface LintResult {
  items: number;
  errors: LintProblem[];
  warnings: LintProblem[];
  /** index.md as lint writes it, and whether the checkout's is that. */
  index: { path: string; text: string; current: boolean };
}

/** What an item says about itself, as lint reads it. */
interface Item {
  file: string; kind: "memory" | "fact"; id: string; type: string; status: string; description: string; paths: string[];
  date: string | null; staleAfter: string | null; supersedes: string[]; supersededBy: string[]; outcomes: Outcome[]; body: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TYPE = /^[a-z][a-z0-9_-]{0,31}$/;
const DAY_MS = 86_400_000;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const rel = (p: string) => (p.startsWith(CONTEXT_DIR) ? p.slice(CONTEXT_DIR.length) : p);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** OKF's reserved files, at any level. */
const reserved = (p: string) => base(p) === "index.md" || base(p) === "log.md";
const kindOf = (p: string): Item["kind"] | null => {
  const r = rel(p);
  if (!p.startsWith(CONTEXT_DIR) || !r.endsWith(".md") || reserved(p)) return null;
  return r.startsWith("memory/") ? "memory" : r.startsWith("facts/") ? "fact" : null;
};
/** A field that is a list of strings, or one string; `bad` when it is anything else. */
const strings = (v: unknown): string[] | "bad" => v === undefined || v === null ? [] : typeof v === "string" ? [v.trim()].filter(Boolean)
  : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).map((x) => x.trim()).filter(Boolean) : "bad";
/** One plain line: no invisible characters, line breaks or marker look-alikes. */
const line = (s: string) => unmark(String(s).replace(/\p{Cf}+/gu, "")).replace(/\s+/g, " ").trim();
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** Words that make a body read as an instruction or a command: memory says what is true, not what to do (§4, §8). */
const INSTRUCTION = /\b(?:ignore|disregard) (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|rules|messages)\b|\byou (?:must|are now|should now)\b|\bsystem prompt\b|<<<|>>>|\bcapcomd (?:merge|approve|grant|spawn|verify)\b|\bgit push\b|\bcurl |\bwget |\brm -rf\b|\bsudo /i;

/** One item's frontmatter, checked: its fields as lint reads them, the problems in them. */
function readItem(f: LintFile & { text: string }, kind: Item["kind"], push: (rule: LintRule, message: string) => void): Item | null {
  const fm = frontmatter(f.text);
  if (fm.state === "none") { push("frontmatter", "no frontmatter: start the file with ---, the item's YAML (id, type, status, description), then ---"); return null; }
  if (fm.state === "invalid") { push("frontmatter", "its frontmatter isn't a YAML map of fields"); return null; }
  const m = fm.meta;
  const slug = rel(f.path).slice(rel(f.path).indexOf("/") + 1, -".md".length);
  const bad = (field: string, want: string) => push("field", `${field}: ${want}`);
  let id = slug;
  if (typeof m.id !== "string" || !ID.test(m.id.trim())) bad("id", `missing or not an id (letters, digits and . _ : -, at most 128); it is read as "${slug}" now, and an id never changes once it lands`);
  else id = m.id.trim();
  if (typeof m.type !== "string" || !TYPE.test(m.type.trim())) bad("type", "missing or not a type (lowercase: lesson, feedback, reference, decision, …), OKF's one required field");
  if (m.status !== undefined && !STATUS.has(String(m.status))) bad("status", "draft, stable or deprecated");
  for (const k of ["modified", "updated", "valid_from", "stale_after"]) if (m[k] !== undefined && m[k] !== null && !instant(m[k])) bad(k, "not a date (2026-11-06, or an ISO instant)");
  const generated = m.generated;
  if (generated !== undefined && generated !== null) {
    if (!isMap(generated)) bad("generated", "a map of by, at and method");
    else {
      if (generated.method !== undefined && !METHODS.has(String(generated.method))) bad("generated.method", [...METHODS].join(", "));
      if (generated.by !== undefined && typeof generated.by !== "string") bad("generated.by", "a string");
      if (generated.at !== undefined && !instant(generated.at)) bad("generated.at", "not a date");
    }
  }
  const lists: Record<string, string[]> = {};
  for (const k of ["supersedes", "superseded_by", "paths"]) {
    const v = strings(m[k]);
    if (v === "bad") { bad(k, "a list of strings"); lists[k] = []; continue; }
    if (k !== "paths") for (const x of v) if (!ID.test(x)) bad(k, `"${line(x).slice(0, 80)}" isn't an id`);
    lists[k] = v;
  }
  const triggers = isMap(m.triggers) ? strings(m.triggers.paths) : [];
  if (triggers === "bad") bad("triggers.paths", "a list of strings");
  const outcomes: Outcome[] = [];
  if (m.outcomes !== undefined && m.outcomes !== null) {
    if (!Array.isArray(m.outcomes)) bad("outcomes", "a list of {kind: verify|merge, id, sha?}");
    else for (const o of m.outcomes) {
      if (!isMap(o) || (o.kind !== "verify" && o.kind !== "merge") || typeof o.id !== "string" || !o.id.trim() || (o.sha !== undefined && typeof o.sha !== "string")) { bad("outcomes", "each one {kind: verify|merge, id, sha?}"); continue; }
      outcomes.push({ kind: o.kind, id: o.id.trim(), ...(typeof o.sha === "string" ? { sha: o.sha } : {}) });
    }
  }
  for (const k of ["helpful", "harmful"]) if (m[k] !== undefined && !(Number.isInteger(m[k]) && (m[k] as number) >= 0)) bad(k, "a whole number, 0 or more");
  if (m.description !== undefined && typeof m.description !== "string") bad("description", "one line of text");
  if (m.title !== undefined && typeof m.title !== "string") bad("title", "one line of text");
  const gen = isMap(generated) ? generated : {};
  const date = instant(m.modified) ?? instant(m.updated) ?? instant(gen.at) ?? instant(m.valid_from) ?? null;
  const title = typeof m.title === "string" && m.title.trim() ? m.title : null;
  return {
    file: f.path, kind, id, type: typeof m.type === "string" && m.type.trim() ? m.type.trim().toLowerCase() : kind === "memory" ? "lesson" : "fact",
    status: STATUS.has(String(m.status)) ? String(m.status) : "draft",
    description: typeof m.description === "string" && m.description.trim() ? m.description : title ?? id,
    paths: [...lists.paths!, ...(triggers === "bad" ? [] : triggers)], date, staleAfter: instant(m.stale_after) ?? null,
    supersedes: lists.supersedes!, supersededBy: lists.superseded_by!, outcomes, body: fm.body,
  };
}

/** index.md as lint writes it: the items by kind (facts, then memory) and path, one line each, from their frontmatter.
 *  Deterministic (no date of its own), so it changes only when an item does. */
export function renderIndex(items: ReadonlyArray<Pick<Item, "file" | "kind" | "id" | "type" | "status" | "description" | "paths" | "date" | "staleAfter" | "supersededBy">>): string {
  const out = ["# Context index", "", "Written by `capcomd context lint --fix` from each item's frontmatter: edit the items, then run it again."];
  const by = (a: { file: string }, b: { file: string }) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  for (const [kind, title] of [["fact", "Facts"], ["memory", "Memory"]] as const) {
    const xs = items.filter((i) => i.kind === kind).sort(by);
    if (!xs.length) continue;
    out.push("", `## ${title}`, "");
    for (const i of xs) {
      const notes = [`id ${i.id}`, ...(i.paths.length ? [`paths: ${i.paths.map(line).join(", ")}`] : []), ...(i.supersededBy.length ? [`superseded by ${i.supersededBy.join(", ")}`] : []),
        i.status, ...(i.staleAfter ? [`stale after ${i.staleAfter.slice(0, 10)}`] : []), ...(i.date && DATE.test(i.date) ? [i.date.slice(0, 10)] : [])];
      out.push(`- [${i.type}] ${line(i.description) || i.id} → ${rel(i.file)} (${notes.join("; ")})`);
    }
  }
  if (!items.length) out.push("", "No items yet.");
  return `${out.join("\n")}\n`;
}

/** The ids of base's items by path (an item without an id is read as its file's name). */
function baseIds(files: LintFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const kind = kindOf(f.path);
    if (!kind || f.text === null) continue;
    const m = frontmatter(f.text).meta;
    const r = rel(f.path);
    out.set(f.path, typeof m.id === "string" && m.id.trim() ? m.id.trim() : r.slice(r.indexOf("/") + 1, -".md".length));
  }
  return out;
}

/** Lint `.capcomd/context/` (the module's header says what is checked). */
export function lintContext(i: LintInput): LintResult {
  const errors: LintProblem[] = [], warnings: LintProblem[] = [];
  const err = (file: string, rule: LintRule, message: string) => errors.push({ file, rule, message });
  const warn = (file: string, rule: LintRule, message: string) => warnings.push({ file, rule, message });
  const files = [...i.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const items: Item[] = [];
  const firstById = new Map<string, Item>();
  const today = Math.floor((i.now ?? Date.now()) / DAY_MS) * DAY_MS;
  for (const f of files) {
    if (f.link) { err(f.path, "unreadable", "a link: .capcomd/context/ holds files, so every agent reads the same thing"); continue; }
    const kind = kindOf(f.path);
    if (!kind) {
      if (!(f.path.startsWith(CONTEXT_DIR) && reserved(f.path))) err(f.path, "not-an-item", ".capcomd/context/ holds items only: memory/<slug>.md, facts/<slug>.md, index.md and log.md");
      continue;
    }
    if (f.text === null) { err(f.path, "unreadable", `not text, or over ${MEMORY_MAX_BYTES / 1024} KB: the memory provider leaves it out`); continue; }
    const hit = i.scan(f.text);
    if (hit) err(f.path, "secret", `holds ${hit.what}: take it out (the item is refused, never redacted)`);
    const item = readItem(f as LintFile & { text: string }, kind, (rule, message) => err(f.path, rule, message));
    if (!item) continue;
    // An item holding a secret is in the index by its id alone: `--fix` never copies the secret into index.md.
    if (hit) Object.assign(item, { description: item.id, paths: [] });
    const first = firstById.get(item.id);
    if (first) { err(f.path, "duplicate-id", `id ${item.id} is already ${rel(first.file)}'s`); continue; }
    firstById.set(item.id, item);
    items.push(item);
    const until = item.staleAfter ? Date.parse(item.staleAfter) : NaN;
    if (item.status !== "deprecated" && Number.isFinite(until) && until <= today) warn(f.path, "stale", `stale since ${item.staleAfter!.slice(0, 10)}: deprecate it, or confirm it with a later stale_after`);
    if (i.descriptionChars && [...item.description].length > i.descriptionChars) warn(f.path, "description", `its description is over ${i.descriptionChars} characters: the brief cuts it there`);
    if (i.itemBytes && Buffer.byteLength(item.body) > i.itemBytes) warn(f.path, "large", `its body is over ${i.itemBytes} bytes: a lesson is one finding, its failure and the guardrail`);
    if (INSTRUCTION.test(item.body)) warn(f.path, "instruction", "its body reads like an instruction or a command: memory says what is true, not what to do; look at it before it lands");
  }

  // Supersession: reciprocal (A supersedes B, and B says it is superseded by A), between items that are here, acyclic.
  const byId = firstById;
  for (const a of items) {
    for (const b of a.supersedes) {
      const other = byId.get(b);
      if (b === a.id) err(a.file, "supersession", "it supersedes itself");
      else if (!other) err(a.file, "supersession", `supersedes ${b}, which isn't an item here (items are deprecated, never deleted)`);
      else if (!other.supersededBy.includes(a.id)) err(other.file, "supersession", `${a.id} supersedes it, so it says superseded_by: [${a.id}]`);
    }
    for (const b of a.supersededBy) {
      const other = byId.get(b);
      if (b === a.id) err(a.file, "supersession", "it is superseded by itself");
      else if (!other) err(a.file, "supersession", `superseded by ${b}, which isn't an item here`);
      else if (!other.supersedes.includes(a.id)) err(other.file, "supersession", `it supersedes ${a.id} (which says so), so it says supersedes: [${a.id}]`);
    }
  }
  const state = new Map<string, "open" | "done">();
  const cycles = new Set<string>();
  const walk = (id: string, path: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      const loop = path.slice(path.indexOf(id));
      const key = [...loop].sort().join(" ");
      if (loop.length > 1 && !cycles.has(key)) { cycles.add(key); err(byId.get(id)!.file, "supersession", `a supersession cycle: ${[...loop, id].join(" → ")}`); }
      return;
    }
    state.set(id, "open");
    for (const next of byId.get(id)?.supersedes ?? []) if (byId.has(next) && next !== id) walk(next, [...path, id]);
    state.set(id, "done");
  };
  for (const a of items) walk(a.id, []);

  // Against the base: an item keeps its id, and is never deleted (moved is fine: the same id at another path).
  const changed = new Set(items.map((x) => x.file));
  if (i.base) {
    const was = baseIds(i.base);
    const now = new Map(items.map((x) => [x.file, x.id]));
    const ids = new Set(items.map((x) => x.id));
    for (const [path, id] of was) {
      const is = now.get(path);
      if (is !== undefined && is !== id) err(path, "id-changed", `its id was ${id}: an id never changes; supersede the item with a new one instead`);
      else if (is === undefined && !ids.has(id) && !files.some((f) => f.path === path)) err(path, "deleted", `item ${id} was deleted: items are never deleted; set status: deprecated instead`);
    }
    const before = new Map(i.base.map((f) => [f.path, f.text]));
    for (const x of items) if (before.get(x.file) === files.find((f) => f.path === x.file)?.text) changed.delete(x.file);
  }
  // The gates an item names: with a run, each outcome of an item this change touches is one of its passed verifies or
  // landed merges.
  if (i.outcome) for (const x of items) if (changed.has(x.file)) for (const o of x.outcomes) if (!i.outcome(o)) err(x.file, "outcome", `${o.kind} ${o.id} isn't a passed verify or a landed merge of the run`);

  const index = renderIndex(items);
  const have = files.find((f) => f.path === INDEX_FILE);
  const current = have?.text === index;
  if (!current && !i.fix && (items.length || have)) err(INDEX_FILE, "index", have ? "out of date with the items: run `capcomd context lint --fix` to write it" : "missing: run `capcomd context lint --fix` to write it");
  return { items: items.length, errors, warnings, index: { path: INDEX_FILE, text: index, current } };
}

/** Every file under `<root>/.capcomd/context/`, as lint reads them: text, or null for a binary or one over 64 KB. */
export function readContextDir(root: string): LintFile[] {
  const out: LintFile[] = [];
  const visit = (dir: string, prefix: string) => {
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const e of entries) {
      if (out.length >= MEMORY_MAX_FILES) return;
      const abs = join(dir, e), path = `${prefix}${e}`;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) { out.push({ path, text: null, link: true }); continue; }
      if (st.isDirectory()) { visit(abs, `${path}/`); continue; }
      if (!st.isFile()) continue;
      if (st.size > MEMORY_MAX_BYTES) { out.push({ path, text: null }); continue; }
      const buf = readFileSync(abs);
      out.push({ path, text: buf.includes(0) ? null : buf.toString("utf8") });
    }
  };
  visit(join(root, CONTEXT_DIR), CONTEXT_DIR);
  return out;
}

/** The same at `ref` in the repository at `root` (local reads only: `git ls-tree` and `git cat-file`). */
export function readContextAt(root: string, ref: string): LintFile[] {
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const ls = git(["ls-tree", "-r", "-z", "--full-tree", ref, "--", CONTEXT_DIR]);
  if (ls.exitCode !== 0) throw new Error(`git can't read ${ref}: ${ls.stderr.toString().trim().split("\n")[0] ?? ""}`);
  const out: LintFile[] = [];
  for (const entry of ls.stdout.toString().split("\0").filter(Boolean).slice(0, MEMORY_MAX_FILES)) {
    const [head, path] = [entry.slice(0, entry.indexOf("\t")), entry.slice(entry.indexOf("\t") + 1)];
    const [mode, type, sha] = head.split(" ");
    if (type !== "blob" || !sha) continue;
    if (mode === "120000") { out.push({ path, text: null, link: true }); continue; }
    const blob = git(["cat-file", "blob", sha]);
    const buf = Buffer.from(blob.stdout);
    out.push({ path, text: blob.exitCode !== 0 || buf.length > MEMORY_MAX_BYTES || buf.includes(0) ? null : buf.toString("utf8") });
  }
  return out;
}
