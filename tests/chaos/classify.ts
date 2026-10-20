// Classify chaos failures. A failure is "host-stall" only when BOTH hold:
//  1. its error is a runtime-readiness signature (rivetkit/engine not ready,
//     actor stopped while waiting, client killed by the case timeout), and
//  2. at least MIN_PEERS other cases overlapping it in wall time were slow
//     (some phase > SLOW_FACTOR x that phase's median across the run).
// Everything else stays "fail". Nothing is retried: a host-stall is recorded,
// shown with its evidence, and counted. See docs/upstream/rivetkit-cold-restart.md.
export const RUNTIME_SIGNATURE =
  /_stopped_while_waiting|actor_ready_timeout|engine not ready|An internal error occurred|internal_error|terminated by signal SIGKILL/;
export const SLOW_FACTOR = 3;
export const MIN_PEERS = 3;
const PHASES = ["engineUp", "firstClient", "restart", "resume"] as const;

export interface Timed {
  ok: boolean;
  error?: string;
  start: number;
  end: number;
  phases: Partial<Record<(typeof PHASES)[number], number>>;
}
export type Outcome = "pass" | "fail" | "host-stall";
export interface Classified { outcome: Outcome; slowPeers: number }

export function medians(rs: Timed[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of PHASES) {
    const xs = rs.map((r) => r.phases[p]).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    if (xs.length) out[p] = xs[Math.floor(xs.length / 2)]!;
  }
  return out;
}

export function isSlow(r: Timed, med: Record<string, number>): boolean {
  return PHASES.some((p) => {
    const v = r.phases[p], m = med[p];
    return typeof v === "number" && typeof m === "number" && m > 0 && v > SLOW_FACTOR * m;
  });
}

export function classify(rs: Timed[]): Classified[] {
  const med = medians(rs);
  return rs.map((r, i) => {
    if (r.ok) return { outcome: "pass", slowPeers: 0 };
    const slowPeers = rs.filter((o, j) => j !== i && o.start < r.end && o.end > r.start && isSlow(o, med)).length;
    const stall = RUNTIME_SIGNATURE.test(r.error ?? "") && slowPeers >= MIN_PEERS;
    return { outcome: stall ? "host-stall" : "fail", slowPeers };
  });
}
