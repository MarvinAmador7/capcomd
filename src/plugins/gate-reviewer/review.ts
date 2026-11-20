// verify's reviewer (the gate-reviewer plugin): an agent profile that reads the change and returns a verdict. Fails
// closed: anything but an explicit {"passed": true|false, ...} is no verdict, and no verdict fails the verify.

export interface Verdict { passed: boolean; reasons: string[] }
/** One of a reviewer's findings (review-verdict@1): the finding, and its severity, file and line when it said them. */
export interface Finding { text: string; severity?: "blocker" | "major" | "minor" | "nit"; file?: string; line?: number }
/** A review as the reviewer gave it: its verdict, and the same reasons as findings (review-verdict@1). */
export interface Review { verdict: Verdict; findings: Finding[] }

const MAX_REASONS = 20;
const MAX_REASON_CHARS = 500;
const SEVERITIES = new Set(["blocker", "major", "minor", "nit"]);

/** A finding the reviewer wrote: a line of text, or `{text, severity?, file?, line?}` (also `reason`/`message` for text). */
function asFinding(f: unknown): Finding | null {
  if (typeof f === "string" || typeof f === "number") { const text = String(f).trim().slice(0, MAX_REASON_CHARS); return text ? { text } : null; }
  if (!f || typeof f !== "object") return null;
  const o = f as Record<string, unknown>;
  const text = String(o.text ?? o.reason ?? o.message ?? "").trim().slice(0, MAX_REASON_CHARS);
  if (!text) return null;
  const file = typeof o.file === "string" && o.file.trim() ? o.file.trim().slice(0, 300) : undefined;
  const line = Number(o.line);
  return {
    text, ...(typeof o.severity === "string" && SEVERITIES.has(o.severity) ? { severity: o.severity as Finding["severity"] } : {}),
    ...(file ? { file } : {}), ...(file && Number.isInteger(line) && line > 0 && line <= 10_000_000 ? { line } : {}),
  };
}

/** A finding as one of the verdict's reasons: "src/add.ts:3: returns a - b". */
export function findingLine(f: Finding): string {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ${f.text}` : f.text;
}

function asReview(v: unknown): Review | null {
  if (!v || typeof v !== "object" || typeof (v as any).passed !== "boolean") return null;
  // review-verdict@1 names them findings; older reviewers say reasons (or reason, feedback): the same lines.
  const raw = (v as any).findings ?? (v as any).reasons ?? (v as any).reason ?? (v as any).feedback;
  const findings = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(asFinding).filter((f): f is Finding => !!f).slice(0, MAX_REASONS);
  return { verdict: { passed: (v as any).passed, reasons: findings.map((f) => findingLine(f).slice(0, MAX_REASON_CHARS)) }, findings };
}

/**
 * The review a reviewer gave: its declared result data (`capcomd result --data`), else the LAST JSON object with a
 * boolean `passed` in its final message (prose or a ```json fence around it is fine). Its `findings` (review-verdict@1),
 * or its `reasons`, are both the verdict's reasons and its findings.
 */
export function parseReview(data: unknown, text?: string): Review | null {
  const declared = asReview(data);
  if (declared) return declared;
  if (!text) return null;
  // Candidate objects: {...} spans that parse, scanning from the end (bounded: the verdict is last).
  let ends = 0;
  for (let end = text.lastIndexOf("}"); end >= 0 && ends < 20; end = text.lastIndexOf("}", end - 1), ends++) {
    let starts = 0;
    for (let start = text.lastIndexOf("{", end); start >= 0 && starts < 20; start = text.lastIndexOf("{", start - 1), starts++) {
      try {
        const v = asReview(JSON.parse(text.slice(start, end + 1)));
        if (v) return v;
      } catch { /* not this span */ }
    }
  }
  return null;
}

/** The verdict alone (parseReview's). */
export function parseVerdict(data: unknown, text?: string): Verdict | null {
  return parseReview(data, text)?.verdict ?? null;
}

/**
 * A reviewer's hand-back, as its parent reads it (its result's summary, rendered as Markdown): the verdict first, then
 * its reasons as bullets, in the reviewer's order (most severe first). No verdict says so, as the gate fails it.
 */
export function verdictSummary(v: Verdict | null): string {
  if (!v) return 'No verdict: the reviewer\'s reply had no {"passed": true|false} line, so the change fails review.';
  const head = v.passed ? "**Approve**" : "**Changes needed**";
  const bullets = v.reasons.map((r) => `- ${r.replace(/\s+/g, " ").trim()}`).filter((r) => r !== "- ");
  return [head, ...(bullets.length ? ["", ...bullets] : [])].join("\n");
}

/** The reviewer's brief: acceptance criteria, plus the task the change was made for. */
export function reviewBrief(o: { criteria?: unknown; childTask?: string | null }): string {
  const c = o.criteria;
  const criteria = c === undefined || c === null ? null : Array.isArray(c) ? c.map((x) => `- ${String(x)}`).join("\n") : typeof c === "string" ? c : JSON.stringify(c, null, 2);
  return [
    "Acceptance criteria:",
    criteria ?? "- The change does what the task below asks, correctly and completely, without breaking existing behavior.",
    ...(o.childTask ? ["", "The change was made for this task:", o.childTask.slice(0, 4000)] : []),
  ].join("\n");
}
