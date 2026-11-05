import type { RunStatus } from "../core/relay";

/** `capcomd status`'s first lines. A run of agents (`run new`: an MCP driver's, a planner's) is described by its agents'
 *  state, budget and spend; a recipe run by its own lifecycle and ledger. */
export function statusText(s: RunStatus): string[] {
  const usd = (n: number) => `$${n.toFixed(n && n < 0.01 ? 4 : 2)}`;
  const sc = s.scope;
  if (!sc) return [`Run: ${s.runId}`, `State: ${s.state}`, `Goal: ${s.goal ?? "-"}`, `Budget: $${s.budget.spent.toFixed(4)} / $${s.budget.maxCost.toFixed(2)}`];
  const counts = Object.entries(sc.byStatus).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
  const spent = Number(sc.spent?.usd ?? 0), cap = sc.budget?.usd, notional = sc.notionalUsd ?? 0;
  const other = Object.entries(sc.budget ?? {}).filter(([u]) => u !== "usd").map(([u, max]) => `${u} ${Number(sc.spent?.[u] ?? 0)} of ${max}`);
  return [
    `Run: ${s.runId}`,
    `State: ${sc.state}`,
    `Goal: ${s.goal || sc.goal || sc.label || "-"}`,
    `Agents: ${sc.agents} (${counts})`,
    `Budget: ${usd(spent)} billed${cap !== undefined ? ` of ${usd(cap)}` : " (no limit)"}${notional > 0 ? `; ${usd(notional)} notional on plan logins` : ""}${other.length ? `; ${other.join(", ")}` : ""}`,
  ];
}

/** `capcomd merge`'s and `capcomd approve`'s lines for a merge a plugin held (merge.landing): who held it and why, the
 *  files it changes (the approval's subject.files, at most `max` named), and how to approve that hold (`again`: after
 *  an approval of something else). */
export function heldMergeText(runId: string, mrgId: string, m: { heldBy: { plugin: string; reason: string }; diff?: { files?: Array<{ path: string }>; filesTotal?: number; added?: number; removed?: number } }, o: { again?: boolean; max?: number } = {}): string[] {
  const max = o.max ?? 5;
  const lines = [`  held by the ${m.heldBy.plugin} plugin: ${m.heldBy.reason}`];
  const d = m.diff;
  if (d && Array.isArray(d.files) && typeof d.filesTotal === "number") {
    const named = d.files.slice(0, max).map((f) => f.path);
    const more = d.filesTotal > named.length && named.length ? `, and ${d.filesTotal - named.length} more` : "";
    lines.push(`  changes ${d.filesTotal} file(s), +${d.added ?? 0} -${d.removed ?? 0}${named.length ? `: ${named.join(", ")}${more}` : ""}`);
  }
  lines.push(`  approve it${o.again ? " again" : ""} to land it: capcomd approve ${runId} ${mrgId}`);
  return lines;
}
