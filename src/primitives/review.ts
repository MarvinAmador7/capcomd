// verify's reviewer: an agent profile that reads the change and returns a verdict. Fails closed:
// anything but an explicit {"passed": true|false, ...} is no verdict, and no verdict fails the verify.

export interface Verdict { passed: boolean; reasons: string[] }

const MAX_REASONS = 20;
const MAX_REASON_CHARS = 500;

function asVerdict(v: unknown): Verdict | null {
  if (!v || typeof v !== "object" || typeof (v as any).passed !== "boolean") return null;
  const raw = (v as any).reasons ?? (v as any).reason ?? (v as any).feedback;
  const reasons = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .map((r) => String(r).slice(0, MAX_REASON_CHARS)).filter(Boolean).slice(0, MAX_REASONS);
  return { passed: (v as any).passed, reasons };
}

/**
 * The verdict a reviewer gave: its declared result data (`capcomd result --data`), else the LAST JSON
 * object with a boolean `passed` in its final message (prose or a ```json fence around it is fine).
 */
export function parseVerdict(data: unknown, text?: string): Verdict | null {
  const declared = asVerdict(data);
  if (declared) return declared;
  if (!text) return null;
  // Candidate objects: {...} spans that parse, scanning from the end (bounded: the verdict is last).
  let ends = 0;
  for (let end = text.lastIndexOf("}"); end >= 0 && ends < 20; end = text.lastIndexOf("}", end - 1), ends++) {
    let starts = 0;
    for (let start = text.lastIndexOf("{", end); start >= 0 && starts < 20; start = text.lastIndexOf("{", start - 1), starts++) {
      try {
        const v = asVerdict(JSON.parse(text.slice(start, end + 1)));
        if (v) return v;
      } catch { /* not this span */ }
    }
  }
  return null;
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
