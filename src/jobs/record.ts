// A job's record as its run's kv keeps it (docs/spec/plugin-api.md §16.2 rule 2): never over a kv value's limit
// (64 KB, src/primitives/board.ts). A settled exec job keeps the last 48 KB of stdout and 16 KB of stderr, which JSON
// escapes (a quote or a newline is two bytes, a control character six) and the rest of the record (a cmd up to 16 KB)
// can push past it; the tails lose their oldest part until it fits.
import { valueBytes } from "../primitives/board";

const jsonBytes = (s: string) => Buffer.byteLength(JSON.stringify(s), "utf8");
/** `s` without its first `n` UTF-16 units, never starting with the second half of a pair it cut. */
const dropHead = (s: string, n: number) => s.slice(n).replace(/^[\uDC00-\uDFFF]/, "");

/**
 * The record as it is stored, at most `max` bytes (UTF-8 JSON): the longer of its output's tails loses its oldest part
 * first, then the other, and `truncated` says so. A record without output, or one whose other fields alone are over
 * (none is: a label, a reason and a cmd are capped well under it), is stored as it is.
 */
export function fitJobRecord<T extends { result?: unknown }>(job: T, max: number): T {
  const res = job.result as { stdout?: unknown; stderr?: unknown } | null | undefined;
  if (valueBytes(job) <= max || !res || typeof res.stdout !== "string" || typeof res.stderr !== "string") return job;
  const out = { stdout: res.stdout, stderr: res.stderr };
  let over = valueBytes({ ...job, result: { ...res, truncated: true } }) - max;
  for (const k of out.stdout.length >= out.stderr.length ? (["stdout", "stderr"] as const) : (["stderr", "stdout"] as const)) {
    if (over <= 0) break;
    // The fewest units to cut: each takes at least a byte off the JSON (so `over` of them always do), often more.
    const s = out[k], want = jsonBytes(s) - over;
    let lo = 0, hi = Math.min(s.length, over);
    while (lo < hi) { const mid = (lo + hi) >> 1; if (jsonBytes(dropHead(s, mid)) <= want) hi = mid; else lo = mid + 1; }
    out[k] = dropHead(s, lo);
    over -= jsonBytes(s) - jsonBytes(out[k]);
  }
  return { ...job, result: { ...res, ...out, truncated: true } };
}
