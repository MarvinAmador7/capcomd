// The schemas capcomd ships (ADR-026 §7), registered when this module loads: an agent's typed hand-back and a
// reviewer's verdict. Their fields are what agents already said in prose (src/subagents/skill.ts HANDBACK): the outcome
// in one sentence, what changed, how it was checked, risks, and what the parent must decide; a reviewer's pass or fail
// and its findings, most severe first. The thread item's shape of each is packages/agent-thread's Handback and Finding.
import { CHECK_RESULTS, FINDING_SEVERITIES, HANDBACK_STATUSES } from "../../packages/agent-thread/src/schema";
import { registerSchema, type JsonSchema } from "./registry";

export const HANDBACK = "handback@1";
export const REVIEW_VERDICT = "review-verdict@1";

const line = (maxLength: number, description: string): JsonSchema => ({ type: "string", minLength: 1, maxLength, description });

export const HANDBACK_V1: JsonSchema = {
  type: "object",
  description: "An agent's hand-back to its parent: the outcome first, then what changed, how it was checked, risks and decisions",
  properties: {
    status: { type: "string", enum: [...HANDBACK_STATUSES], description: "done: the task is done; partly: some of it is; blocked: it can't go on without something or someone" },
    outcome: line(300, "The outcome in one sentence: what was done (or what blocks it)"),
    changed: {
      type: "array", maxItems: 50, description: "The files it changed",
      items: { type: "object", properties: { path: line(300, "Relative to the repository"), what: line(200, "What changed in it, briefly") }, required: ["path"] },
    },
    checked: {
      type: "array", maxItems: 20, description: "How it was checked: each command (or way) and its result",
      items: {
        type: "object", required: ["check", "result"],
        properties: { check: line(300, "The command, or how it was checked"), result: { type: "string", enum: [...CHECK_RESULTS] }, note: line(300, "What it showed") },
      },
    },
    risks: { type: "array", maxItems: 10, description: "Deviations from the task and risks, if any", items: line(300, "One deviation or risk") },
    decide: { type: "array", maxItems: 10, description: "What the parent must decide, if anything", items: line(300, "One question") },
  },
  required: ["status", "outcome"],
};

export const REVIEW_VERDICT_V1: JsonSchema = {
  type: "object",
  description: "A reviewer's verdict on a change: passed or not, and its findings, most severe first",
  properties: {
    passed: { type: "boolean" },
    findings: {
      type: "array", maxItems: 20,
      items: {
        type: "object", required: ["text"],
        properties: {
          text: line(500, "The finding, one line; on a fail, what must change"),
          severity: { type: "string", enum: [...FINDING_SEVERITIES] },
          file: line(300, "The file it is about, relative to the repository"),
          line: { type: "integer", minimum: 1, maximum: 10_000_000 },
        },
      },
    },
  },
  required: ["passed"],
};

registerSchema(HANDBACK, HANDBACK_V1, "An agent's typed hand-back: status, outcome, changed, checked, risks, decide");
registerSchema(REVIEW_VERDICT, REVIEW_VERDICT_V1, "A reviewer's verdict: passed, findings");

/** A typed payload as a result carries it: which schema, and the value that was checked against it. */
export interface Typed { schema: string; value: Record<string, any> }

const STATUS_WORD: Record<string, string> = { done: "Done", partly: "Partly done", blocked: "Blocked" };
/** Markdown-safe inline text: one line, no backticks (a path goes in a code span). */
const flat = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const code = (s: unknown) => `\`${flat(s).replace(/`/g, "'")}\``;

/**
 * handback@1 as the prose hand-back its parent and older clients read (the shape src/subagents/skill.ts HANDBACK asks
 * for): "Done: added X.", then bullets for what changed, how it was checked, each risk and each decision.
 */
export function handbackMarkdown(h: Record<string, any>): string {
  const outcome = flat(h.outcome);
  const head = `${STATUS_WORD[h.status] ?? "Done"}: ${outcome}${/[.!?]$/.test(outcome) ? "" : "."}`;
  const bullets: string[] = [];
  const changed = Array.isArray(h.changed) ? h.changed : [];
  if (changed.length) bullets.push(`- Changed: ${changed.map((c: any) => `${code(c.path)}${c.what ? ` (${flat(c.what)})` : ""}`).join(", ")}.`);
  const checked = Array.isArray(h.checked) ? h.checked : [];
  if (checked.length) bullets.push(`- Checked: ${checked.map((c: any) => `${flat(c.check)}: ${c.result}${c.note ? ` (${flat(c.note)})` : ""}`).join("; ")}.`);
  for (const r of Array.isArray(h.risks) ? h.risks : []) bullets.push(`- Risk: ${flat(r)}`);
  for (const d of Array.isArray(h.decide) ? h.decide : []) bullets.push(`- Decide: ${flat(d)}`);
  return [head, ...bullets].join("\n");
}
