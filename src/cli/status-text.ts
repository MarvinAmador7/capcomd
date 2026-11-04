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
