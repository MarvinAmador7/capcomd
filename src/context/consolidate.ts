// Consolidation (ADR-025 §5.2, §5.3, step 3): what a `context-consolidator` agent said, staged as files under
// `.capcomd/context/`. The consolidator (a model, the run's strongest, spawned by the planner as its run's last child)
// reads the run's candidates (kv `_context/*`, ./capture.ts), its verify verdicts and merge outcomes and the project's
// memory, and answers with itemised deltas: the `ContextProposal`s an agent proposes (`add`, `supersede`,
// `deprecate`), each naming the candidates it comes `from` and the gates (`outcomes`) that confirmed it. It writes no
// file itself: the kernel stages its deltas here, by plain rules and no model (ACE's curator), with provenance from the
// kernel's records, so its branch is lint-clean by construction and changes nothing outside `.capcomd/context/`.
// Deterministic for one input, so a replay stages the same files:
//  - an `add` the lexical match finds said already (an active item, or an earlier add of this staging) isn't added
//    again; a memory item's `helpful` counter goes up instead (with a change: counters alone stage nothing; a fact's
//    never does);
//  - an `add` titled as an active memory item is (one subject, said differently) supersedes it: the brief never shows
//    two active items with one subject, and the newer one wins (a correction outlives what it corrected);
//  - `supersede` writes the new item with `supersedes: [target]` and marks the target `superseded_by` it and
//    deprecated; `deprecate` marks the target deprecated. A target is an active memory item (a fact changes by a
//    person's commit), changed at most once per staging;
//  - every string a delta keeps is scanned (./scan.ts) and a delta holding a secret (or the redactor's placeholder)
//    refused, never redacted; one over `itemBytes`, past `proposalsPerRun`, naming a candidate that isn't the run's or
//    an outcome that isn't one of its passed verifies or landed merges is refused too;
//  - a new item is a draft (saving never raises authority), `generated` by the consolidator (`agent-generated`), its
//    `origin` the kernel's record of it, its `sources` the candidates it consolidates (who proposed each, with which
//    profile and model), its `stale_after` from its type's retention (D8: lesson 180 days, feedback 90, reference none);
//  - index.md is the one lint writes (./lint.ts renderIndex).
// A delta that names a brain (`brain: <name>`, ADR-025 step 5) is a proposal to a company's brain, never a change to the
// project's memory: `stage` leaves it out and `brainDeltas` checks it (the brain its profile names, groundray's types,
// a new draft only, the same scan and limits), for the kernel to send through groundray (./brain-proposals.ts).
import { createHash } from "crypto";
import type { ContextProposal, ContextSpec, Outcome, Provenance } from "../../packages/plugin/src/context-layer";
import { REDACTED } from "../agents/redact";
import { proposalOf, type Candidate, type RefuseReason } from "./capture";
import { INDEX_FILE, lintContext, type LintFile, type LintProblem } from "./lint";
import { CONTEXT_DIR, STATUS, frontmatter } from "./memory";
import type { ScanHit } from "./scan";
import { BRAIN_NAME_RE, draftProblem, GROUNDRAY_TYPES, isGroundrayType, type GroundrayType } from "./groundray-write";

/** The profile whose branch may change `.capcomd/context/` (ADR-025 §5.2): its agents are staged here, never captured. */
export const CONSOLIDATOR_PROFILE = "context-consolidator";

/** D8: how long an item of a type stays fresh, in days (null: always). A profile's `retain` sets its own. */
export const RETAIN_DAYS: Readonly<Record<string, number | null>> = { lesson: 180, feedback: 90, reference: null };

export type StageReason = RefuseReason | "no_target" | "conflict" | "unknown_source" | "outcome" | "no_brain";
export interface StageRefusal { n: number; reason: StageReason; what: string }
/** What a delta did: `duplicate` added nothing (the item it repeats, `id`, counts one more `helpful`). */
export interface Applied { n: number; op: "add" | "supersede" | "deprecate" | "duplicate"; id: string; path: string; target?: string }

export interface StageInput {
  /** `.capcomd/context/` at the commit the branch is cut from. */
  files: LintFile[];
  /** The consolidator's `context` list, as it said it. */
  raw: unknown;
  /** The run's candidates: what a delta's `from` may name. */
  candidates: ReadonlyArray<Candidate>;
  /** The consolidator, from the kernel's records. */
  origin: NonNullable<Provenance["origin"]>;
  at: string;
  scan: (text: string) => ScanHit | null;
  /** Whether an outcome is a passed verify or a landed merge of the run. */
  outcome: (o: Outcome) => boolean;
  itemBytes: number | null;
  descriptionChars: number;
  /** How many deltas it may apply (`proposalsPerRun`); null: no limit. */
  room: number | null;
  /** Days an item of a type stays fresh, over D8's. */
  retain?: Readonly<Record<string, number | null>>;
}

export interface Staged {
  /** The files to write (whole), in path order: new items, changed ones and index.md when it changes. */
  writes: Array<{ path: string; text: string }>;
  applied: Applied[];
  refused: StageRefusal[];
  /** Fields the deltas had that a delta doesn't: not taken. */
  ignored: string[];
  /** Lint on the staged tree against the base (problems here were the base's: the branch fails its verify on them). */
  lint: { errors: LintProblem[]; warnings: LintProblem[] };
}

/** A delta: a proposal, and what only a consolidator says (the candidates it consolidates, the gates that confirmed it). */
const FIELDS = new Set(["text", "title", "type", "op", "target", "from", "outcomes", "brain"]);
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const CANDIDATE_ID = /^agt-[A-Za-z0-9_-]{1,64}\.\d{1,4}$/;
const MAX_FROM = 50, MAX_OUTCOMES = 20;
const DAY_MS = 86_400_000;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A delta for a brain: `brainDeltas` stages it, `stage` leaves it out. */
const forBrain = (v: unknown) => isMap(v) && v.brain !== undefined;
/** Loaded on first use: the orchestration skill names the consolidator's profile from here, and few processes stage. */
const yaml = () => require("yaml") as typeof import("yaml");
const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
/** Two texts say the same thing when most of their words are the same (Jaccard ≥ 0.8). */
function same(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both) >= 0.8;
}
const subject = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** An item of the base, as staging needs it. */
interface Item { path: string; id: string; kind: "memory" | "fact"; status: string; title: string; words: Set<string>; supersededBy: string[]; helpful: number }

function baseItems(files: LintFile[]): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const f of [...files].sort(byPath)) {
    if (f.text === null || f.link || !f.path.startsWith(CONTEXT_DIR) || !f.path.endsWith(".md")) continue;
    const rel = f.path.slice(CONTEXT_DIR.length), name = rel.slice(rel.lastIndexOf("/") + 1);
    const kind = rel.startsWith("memory/") ? "memory" : rel.startsWith("facts/") ? "fact" : null;
    if (!kind || name === "index.md" || name === "log.md") continue;
    const fm = frontmatter(f.text);
    if (fm.state !== "ok") continue;
    const m = fm.meta;
    const id = typeof m.id === "string" && m.id.trim() ? m.id.trim() : rel.slice(rel.indexOf("/") + 1, -".md".length);
    if (out.has(id)) continue;
    const sb = Array.isArray(m.superseded_by) ? m.superseded_by.filter((x): x is string => typeof x === "string") : typeof m.superseded_by === "string" ? [m.superseded_by] : [];
    out.set(id, {
      path: f.path, id, kind, status: STATUS.has(String(m.status)) ? String(m.status) : "draft",
      title: typeof m.title === "string" && m.title.trim() ? m.title.trim() : "", words: words(fm.body), supersededBy: sb,
      helpful: Number.isInteger(m.helpful) && (m.helpful as number) >= 0 ? (m.helpful as number) : 0,
    });
  }
  return out;
}
const active = (i: Item) => i.status !== "deprecated" && !i.supersededBy.length;

/** `text` with its frontmatter's fields set (the rest of it, its comments and its body as they were). */
export function withFields(text: string, set: Record<string, unknown>): string {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error("no frontmatter");
  const doc = yaml().parseDocument(m[1]!);
  for (const [k, v] of Object.entries(set)) doc.set(k, v);
  return `---\n${doc.toString({ lineWidth: 0 })}---\n${text.slice(m[0].length)}`;
}

/** A new item's file: its frontmatter (kernel-stamped) and its text as the body. */
function itemText(meta: Record<string, unknown>, body: string): string {
  return `---\n${yaml().stringify(meta, { lineWidth: 0 })}---\n\n${body.trim()}\n`;
}

/** A new item's id: a slug of its title (else its first words) and a short hash of the run and its text, so a replay
 *  names it the same and two runs' items never collide. */
function newId(p: ContextProposal, runId: string): string {
  const slug = [...(p.title ?? p.text.text).toLowerCase().normalize("NFKD").matchAll(/[a-z0-9]+/g)].map((x) => x[0]).slice(0, 6).join("-").slice(0, 48).replace(/-+$/, "") || "lesson";
  return `${slug}-${createHash("sha256").update(`${runId}\0${p.text.text}`).digest("hex").slice(0, 6)}`;
}

/** One line of a description: the title, else the text's first line, cut to `max` characters. */
function describe(p: ContextProposal, max: number): string {
  const first = (p.title ?? p.text.text.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  const cps = [...first];
  return cps.length > max ? `${cps.slice(0, Math.max(1, max - 1)).join("")}…` : first;
}

/** The outcomes a delta names: each a verify or a merge by id; null when one isn't well formed. */
function outcomesOf(v: unknown): Outcome[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_OUTCOMES) return null;
  const out: Outcome[] = [];
  for (const o of v) {
    if (!isMap(o) || (o.kind !== "verify" && o.kind !== "merge") || typeof o.id !== "string" || !/^(?:vfy|mrg)-[A-Za-z0-9_-]{1,64}$/.test(o.id) || (o.sha !== undefined && (typeof o.sha !== "string" || !/^[0-9a-f]{7,64}$/.test(o.sha)))) return null;
    out.push({ kind: o.kind, id: o.id, ...(typeof o.sha === "string" ? { sha: o.sha } : {}) });
  }
  return out;
}

/** Stage a consolidator's deltas on `.capcomd/context/` as it is at the base (the module's header says how). */
export function stage(i: StageInput): Staged {
  const items = baseItems(i.files);
  const texts = new Map(i.files.filter((f) => f.text !== null && !f.link).map((f) => [f.path, f.text!]));
  const candidates = new Map(i.candidates.map((c) => [c.id, c]));
  const applied: Applied[] = [], refused: StageRefusal[] = [];
  const ignored = new Set<string>();
  /** Files this staging changed (path → text), and the targets it changed (one change each). */
  const changed = new Map<string, string>(), touched = new Set<string>();
  /** The items it added, for the lexical match against later deltas. */
  const added: Array<{ id: string; path: string; words: Set<string> }> = [];
  const retain = { ...RETAIN_DAYS, ...(i.retain ?? {}) };
  const textOf = (path: string) => changed.get(path) ?? texts.get(path)!;
  const set = (path: string, fields: Record<string, unknown>) => changed.set(path, withFields(textOf(path), fields));
  let used = 0;

  (Array.isArray(i.raw) ? i.raw : []).forEach((v, k) => {
    const n = k + 1;
    const refuse = (reason: StageReason, what: string) => { refused.push({ n, reason, what }); };
    if (forBrain(v)) return;
    if (isMap(v)) for (const f of Object.keys(v)) if (!FIELDS.has(f) && FIELD_NAME.test(f) && !i.scan(f)) ignored.add(f);
    const p = proposalOf(v, i.origin.agentId);
    if (!p) return refuse("invalid", "isn't a delta: give it a text, and at most a title, a type, an op, a target, from and outcomes");
    const d = v as Record<string, unknown>;
    const from = d.from === undefined ? [] : Array.isArray(d.from) && d.from.length <= MAX_FROM && d.from.every((x) => typeof x === "string" && CANDIDATE_ID.test(x)) ? [...new Set(d.from as string[])] : null;
    const outcomes = outcomesOf(d.outcomes);
    if (!from || !outcomes) return refuse("invalid", "isn't a delta: from is a list of candidate ids, outcomes a list of {kind: verify|merge, id}");
    const t = p.target;
    const all = [p.title ?? "", p.type ?? "", t?.provider ?? "", t?.id ?? "", t?.version ?? "", p.text.text].join("\n");
    const hit = i.scan(all);
    if (hit) return refuse(hit.reason, `holds ${hit.what}`);
    // A credential the redactor took out on the way here (a final message, an RPC's arguments): what is left around it
    // may still be part of one, so the delta is refused, not landed with a placeholder.
    if (all.includes(REDACTED)) return refuse("token", "held something shaped like a credential, which was redacted on its way here");
    const bytes = Buffer.byteLength(p.text.text);
    if (i.itemBytes !== null && bytes > i.itemBytes) return refuse("too_large", `is over the ${i.itemBytes}-byte limit for one item`);
    const unknown = from.find((c) => !candidates.has(c));
    if (unknown) return refuse("unknown_source", `names ${unknown}, which isn't a candidate of this run`);
    const bad = outcomes.find((o) => !i.outcome(o));
    if (bad) return refuse("outcome", `names ${bad.kind} ${bad.id}, which isn't a passed verify or a landed merge of this run`);

    // What it is about: the target it names, else (an add) an active memory item with its title.
    let op = p.op ?? "add";
    let target = t ? items.get(t.id) : undefined;
    if (t && (t.provider !== "memory" || !target)) return refuse("no_target", `is about ${t.id}, which isn't an item of the project's memory here`);
    const w = words(p.text.text);
    if (op === "add") {
      // Said already: by an active item (one more `helpful`), or by an earlier delta of this staging (nothing more).
      const twin = added.find((x) => same(w, x.words));
      if (twin) return void applied.push({ n, op: "duplicate", id: twin.id, path: twin.path });
      const known = [...items.values()].find((x) => active(x) && !touched.has(x.id) && same(w, x.words));
      if (known) {
        // A fact is a person's to change, its counters too: said already, so nothing is added, and nothing counted.
        if (known.kind === "fact") return void applied.push({ n, op: "duplicate", id: known.id, path: known.path });
        set(known.path, { helpful: known.helpful + 1 });
        touched.add(known.id);
        return void applied.push({ n, op: "duplicate", id: known.id, path: known.path });
      }
      const sameSubject = p.title ? [...items.values()].find((x) => x.kind === "memory" && active(x) && x.title && subject(x.title) === subject(p.title!)) : undefined;
      if (sameSubject) { op = "supersede"; target = sameSubject; }
    }
    if (op !== "add") {
      if (!target || target.kind !== "memory") return refuse("no_target", `is about ${t?.id ?? "an item"}, which isn't an item of the project's memory here (a fact changes by a person's commit)`);
      if (!active(target)) return refuse("no_target", `is about ${target.id}, which is deprecated or superseded already`);
      if (touched.has(target.id)) return refuse("conflict", `is about ${target.id}, which an earlier delta of this run changed already`);
    }
    if (i.room !== null && used >= i.room) return refuse("over_cap", "would pass the run's limit on lessons (limits.proposalsPerRun)");
    if (op === "deprecate") {
      used++;
      set(target!.path, { status: "deprecated" });
      touched.add(target!.id);
      return void applied.push({ n, op, id: target!.id, path: target!.path });
    }
    // A new item (an add, or what supersedes the target).
    const id = newId(p, i.origin.runId);
    const path = `${CONTEXT_DIR}memory/${id}.md`;
    if (items.has(id) || texts.has(path) || changed.has(path)) return void applied.push({ n, op: "duplicate", id, path });
    used++;
    const type = p.type ?? "lesson";
    const days = Object.hasOwn(retain, type) ? retain[type] : null;
    const sources = from.map((c) => {
      const o = candidates.get(c)!.provenance.origin;
      return { id: c, resource: `capcomd:${i.origin.runId}/${o?.agentId ?? "?"}`, title: `proposed by ${o?.agentId ?? "an agent"} (${[o?.profile, o?.model].filter(Boolean).join(", ") || "unknown profile"})` };
    });
    const meta: Record<string, unknown> = {
      id, type, title: p.title ?? describe(p, i.descriptionChars), description: describe(p, i.descriptionChars), status: "draft",
      generated: { by: `process:${i.origin.agentId}`, at: i.at, method: "agent-generated" },
      origin: { ...i.origin },
      ...(days ? { stale_after: new Date(Date.parse(i.at) + days * DAY_MS).toISOString() } : {}),
      ...(op === "supersede" ? { supersedes: [target!.id] } : {}),
      ...(outcomes.length ? { outcomes } : {}),
      ...(sources.length ? { sources } : {}),
    };
    changed.set(path, itemText(meta, p.text.text));
    added.push({ id, path, words: w });
    if (op === "supersede") {
      set(target!.path, { status: "deprecated", superseded_by: [...target!.supersededBy, id] });
      touched.add(target!.id);
      return void applied.push({ n, op, id, path, target: target!.id });
    }
    applied.push({ n, op: "add", id, path });
  });

  // Counters alone aren't worth a branch (and a person's look): they ride along with a change.
  if (!applied.some((x) => x.op !== "duplicate")) changed.clear();
  // The tree as it would be, index.md written by lint from it.
  const next = (): LintFile[] => [...i.files.filter((f) => !changed.has(f.path)), ...[...changed].map(([path, text]) => ({ path, text }))];
  const lint = (fix: boolean) => lintContext({ files: next(), base: i.files, scan: i.scan, outcome: i.outcome, fix, itemBytes: i.itemBytes, descriptionChars: i.descriptionChars, now: Date.parse(i.at) });
  if (changed.size) {
    const index = lint(true).index.text;
    if (texts.get(INDEX_FILE) !== index) changed.set(INDEX_FILE, index);
  }
  const r = changed.size ? lint(false) : { errors: [], warnings: [] };
  return {
    writes: [...changed].map(([path, text]) => ({ path, text })).sort(byPath),
    applied, refused, ignored: [...ignored].sort(), lint: { errors: r.errors, warnings: r.warnings },
  };
}

/** The brain a profile's context block names (its `groundray` entry's `brain`), or null: the one a consolidator of that
 *  profile may propose to. */
export function brainOf(context: ContextSpec | null | undefined): string | null {
  const b = context?.providers?.find((p) => p.name === "groundray")?.brain;
  return typeof b === "string" && BRAIN_NAME_RE.test(b) ? b : null;
}

/** A consolidator's proposal to a brain, checked: what the kernel keeps for groundray (./brain-proposals.ts). */
export interface BrainDelta { n: number; brain: string; type: GroundrayType; title: string; text: string; from: string[] }

export interface BrainStageInput {
  raw: unknown;
  /** The brain the consolidator's profile names (`brainOf`), or null: it may propose to none. */
  brain: string | null;
  candidates: ReadonlyArray<Candidate>;
  agentId: string;
  scan: (text: string) => ScanHit | null;
  itemBytes: number | null;
  /** How many it may keep (`proposalsPerRun`, shared with the memory's changes, which come after); null: no limit. */
  room: number | null;
}

/**
 * The deltas of a consolidator's answer that name a brain (`brain: <name>`), checked as a memory delta is (a proposal,
 * its `from` the run's candidates, every string scanned and a secret or the redactor's placeholder refused, within
 * `itemBytes` and the run's room) and as groundray needs (the brain its profile names, one of groundray's types, a
 * one-line title, a body without frontmatter, a new draft only: a brain's items are superseded and deprecated by its
 * owners). Deterministic for one input. Numbered as `stage` numbers its own, by their place in the answer.
 */
export function brainDeltas(i: BrainStageInput): { accepted: BrainDelta[]; refused: StageRefusal[] } {
  const accepted: BrainDelta[] = [], refused: StageRefusal[] = [];
  (Array.isArray(i.raw) ? i.raw : []).forEach((v, k) => {
    const n = k + 1;
    if (!forBrain(v)) return;
    const refuse = (reason: StageReason, what: string) => { refused.push({ n, reason, what }); };
    const d = v as Record<string, unknown>;
    if (typeof d.brain !== "string" || !BRAIN_NAME_RE.test(d.brain) || d.brain !== i.brain) {
      return refuse("no_brain", i.brain ? `is for a brain other than ${i.brain}, the one its profile names` : "is for a brain, and its profile names none (context.providers: [{name: groundray, brain: <name>}])");
    }
    const p = proposalOf(v, i.agentId);
    if (!p) return refuse("invalid", "isn't a proposal: give it a text, a title and one of groundray's types");
    if ((p.op ?? "add") !== "add" || p.target) return refuse("invalid", "isn't a new draft: a brain's items are superseded and deprecated by its owners, so a proposal to it only adds");
    if (!isGroundrayType(d.type)) return refuse("invalid", `has no type groundray knows (${GROUNDRAY_TYPES.join(", ")})`);
    const from = d.from === undefined ? [] : Array.isArray(d.from) && d.from.length <= MAX_FROM && d.from.every((x) => typeof x === "string" && CANDIDATE_ID.test(x)) ? [...new Set(d.from as string[])] : null;
    if (!from) return refuse("invalid", "isn't a delta: from is a list of candidate ids");
    const all = [p.title ?? "", d.type, p.text.text].join("\n");
    const hit = i.scan(all);
    if (hit) return refuse(hit.reason, `holds ${hit.what}`);
    if (all.includes(REDACTED)) return refuse("token", "held something shaped like a credential, which was redacted on its way here");
    if (i.itemBytes !== null && Buffer.byteLength(p.text.text) > i.itemBytes) return refuse("too_large", `is over the ${i.itemBytes}-byte limit for one item`);
    const unknown = from.find((c) => !i.candidates.some((x) => x.id === c));
    if (unknown) return refuse("unknown_source", `names ${unknown}, which isn't a candidate of this run`);
    const problem = draftProblem({ type: d.type, title: p.title ?? "", body: p.text.text });
    if (problem) return refuse("invalid", problem);
    if (i.room !== null && accepted.length >= i.room) return refuse("over_cap", "would pass the run's limit on lessons (limits.proposalsPerRun)");
    accepted.push({ n, brain: i.brain!, type: d.type, title: p.title!, text: p.text.text, from });
  });
  return { accepted, refused };
}

/**
 * The consolidator's `context` list in its final message: the message as JSON (`{"context": [...]}` or the list
 * itself), else the last fenced ```json block, else the outermost braces. null when there's none.
 */
export function deltasIn(text: string | null | undefined): unknown[] | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const listOf = (s: string): unknown[] | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return Array.isArray(v) ? v : isMap(v) && Array.isArray(v.context) ? v.context : null;
    } catch { return null; }
  };
  const blocks = [...t.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/g)].map((m) => m[1]!);
  for (const s of [t, ...blocks.reverse(), t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)]) {
    const l = s ? listOf(s) : null;
    if (l) return l;
  }
  return null;
}
