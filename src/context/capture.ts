// Capture (ADR-025 §5.1, §11.1, step 2): the lessons an agent proposes for the project's memory, as candidates of its
// run. An agent that declares its result with `capcomd result --data '{"context": [...]}'` (what the orchestration
// skill teaches) proposes each element; the kernel's `context` plugin collects them when the agent ends (`agent.changed`
// `ended`, src/plugins/context.ts) from the record its token wrote (kv `_result/<agentId>`, written as the token's
// `sub`), never from the payload: who proposed a lesson, in which run, with which profile and model, is stamped here
// from the kernel's records, and whatever else an element says about itself (`by`, `origin`, `status`, `verified`) is
// ignored. Each candidate is checked by the seeded secret scan (./scan.ts) and refused, never redacted, when it holds
// a secret; one over `limits.itemBytes`, or past the run's `limits.proposalsPerRun`, is refused too. What is accepted
// is kept, kernel-stamped, in kv `_context/<agentId>` (reserved: only the kernel writes it; every agent of the run
// reads it), where the consolidator (step 3) finds it; nothing here reaches a shared layer.
import type { ContextProposal, ContextRef, Provenance } from "../../packages/plugin/src/context-layer";
import type { ScanHit, ScanReason } from "./scan";

/** Where a run keeps its candidates: `_context/<agentId>`, one record per agent, written once. */
export const CANDIDATES_KV = "_context/";

export type RefuseReason = ScanReason | "invalid" | "too_large" | "over_cap";

/** A candidate lesson: what the agent said, and who said it, as the kernel recorded it. */
export interface Candidate {
  /** `<agentId>.<n>`: `n` its place in the agent's `result.data.context`, from 1. */
  id: string;
  proposal: ContextProposal;
  provenance: Provenance;
  bytes: number;
}
export interface Refusal { n: number; reason: RefuseReason; what: string }

/** What one agent's end leaves in its run (kv `_context/<agentId>`). */
export interface CaptureRecord {
  agentId: string; profile: string; at: string; candidates: Candidate[]; refused: Array<Omit<Refusal, "what">>;
  /** Fields the agent's elements had that a proposal doesn't (`by`, `origin`, `status`…): not taken. */
  ignored: string[];
}

export interface CaptureInput {
  /** `result.data.context` as the agent declared it. */
  raw: unknown;
  /** From the kernel's records: the agent its token names, its run, profile and model. */
  origin: NonNullable<Provenance["origin"]>;
  at: string;
  scan: (text: string) => ScanHit | null;
  itemBytes: number | null;
  /** How many more candidates the run takes (`proposalsPerRun` less what it has); null: no limit. */
  room: number | null;
}

/** What a proposal is (`ContextProposal`); anything else in an element is ignored. */
const FIELDS = new Set(["text", "title", "type", "op", "target"]);
const TYPE = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPS = new Set(["add", "supersede", "deprecate"]);
/** A name `ignored` lists: one shaped like a field's (anything else, a secret used as a key say, isn't repeated). */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The proposal in an element, or null when it isn't one: a text, and at most a one-line title, a type, an op and,
 *  for `supersede` and `deprecate`, the item it is about. */
function proposalOf(v: unknown, by: string): ContextProposal | null {
  if (!isMap(v)) return null;
  const text = typeof v.text === "string" ? v.text : isMap(v.text) && typeof v.text.text === "string" ? v.text.text : null;
  if (text === null || !text.trim()) return null;
  if (v.title !== undefined && (typeof v.title !== "string" || !v.title.trim() || v.title.length > 200 || /[\r\n]/.test(v.title))) return null;
  if (v.type !== undefined && (typeof v.type !== "string" || !TYPE.test(v.type))) return null;
  const op = v.op === undefined ? "add" : v.op;
  if (typeof op !== "string" || !OPS.has(op)) return null;
  let target: ContextRef | undefined;
  if (v.target !== undefined || op !== "add") {
    const t = v.target;
    if (!isMap(t) || typeof t.id !== "string" || !ID.test(t.id)) return null;
    if (t.provider !== undefined && (typeof t.provider !== "string" || !TYPE.test(t.provider))) return null;
    if (t.version !== undefined && (typeof t.version !== "string" || t.version.length > 128)) return null;
    target = { provider: (t.provider as string | undefined) ?? "memory", id: t.id, version: (t.version as string | undefined) ?? "" };
  }
  return {
    text: { text, untrusted: true, by },
    ...(typeof v.title === "string" ? { title: v.title.trim() } : {}),
    type: (v.type as string | undefined) ?? "lesson",
    op: op as NonNullable<ContextProposal["op"]>,
    ...(target ? { target } : {}),
  };
}

/**
 * The candidates in one agent's `result.data.context` (each element a proposal): checked in order, each refused when
 * it isn't a proposal, holds a secret (the scan's reason), is over `itemBytes` or comes after the run's room is used up.
 * Provenance is the kernel's (`origin`, `at`); `ignored` names the fields elements had that a proposal doesn't (an
 * agent can't say who wrote a lesson or how far it is trusted).
 */
export function capture(i: CaptureInput): { accepted: Candidate[]; refused: Refusal[]; ignored: string[] } {
  const accepted: Candidate[] = [], refused: Refusal[] = [];
  const ignored = new Set<string>();
  const list = Array.isArray(i.raw) ? i.raw : [];
  list.forEach((v, k) => {
    const n = k + 1;
    // A name is listed only when it is a field's and holds no secret: `ignored` is kept and told as the rest is.
    if (isMap(v)) for (const f of Object.keys(v)) if (!FIELDS.has(f) && FIELD_NAME.test(f) && !i.scan(f)) ignored.add(f);
    const p = proposalOf(v, i.origin.agentId);
    if (!p) return refused.push({ n, reason: "invalid", what: "isn't a lesson: give it a text, and at most a title, a type, an op and a target" });
    // Every string the candidate keeps is scanned, its target's too.
    const t = p.target;
    const hit = i.scan([p.title ?? "", p.type ?? "", t?.provider ?? "", t?.id ?? "", t?.version ?? "", p.text.text].join("\n"));
    if (hit) return refused.push({ n, reason: hit.reason, what: `holds ${hit.what}` });
    const bytes = Buffer.byteLength(p.text.text);
    if (i.itemBytes !== null && bytes > i.itemBytes) return refused.push({ n, reason: "too_large", what: `is over the ${i.itemBytes}-byte limit for one lesson` });
    if (i.room !== null && accepted.length >= i.room) return refused.push({ n, reason: "over_cap", what: "would pass the run's limit on lessons (limits.proposalsPerRun)" });
    accepted.push({
      id: `${i.origin.agentId}.${n}`, proposal: p, bytes,
      provenance: { method: "agent-generated", by: `process:${i.origin.agentId}`, at: i.at, origin: { ...i.origin }, sources: [] },
    });
  });
  return { accepted, refused, ignored: [...ignored].sort() };
}
