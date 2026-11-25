// ADR-026 §6: hibernation is a latency optimization, never a requirement. A planner or lead (an orchestrate profile, or a
// root agent: the user replies to it in its thread) whose turn ended is kept on a parked machine instead of having it
// destroyed, so a message wakes it in a moment (§5 path 2: its checkout and CLI session are still there). Workers are
// destroyed when their attempt ends, as before: their branch and saved session are enough to wake them anywhere.
//
// A parked machine is deleted when its retention passes (the place's setting, recorded per run: its worker's own alarm,
// boxd's setDeleteAfter, Docker's sweep), when more than 10 are parked at its place (the oldest first, so parked machines
// never crowd out new ones against the provider's limit), when its run is archived, its agent cancelled, or the user
// deletes it (Settings › Machines). Its saved session stays in every case: archiving can be undone.
import { client } from "../core/relay";
import type { ScopeAgent } from "../actors/scope";
import { parkedMachines, type AgentMachine, type ParkedMachine } from "../providers/machines";
import type { DeleteCause } from "../providers/machine-audit";
import { parkedMax } from "../providers/settings";
import { pinnedMachine } from "../profiles";
import { subtree } from "../subagents/results";
import { CONSOLIDATOR_PROFILE } from "../context/consolidate";

/** Whether agent `a` keeps its machine parked when its turn ends: a planner or lead (an orchestrate profile, or a root
 *  agent: the one the user talks to), never a reviewer, a report agent or the consolidator (nothing continues those). */
export function parkable(a: Pick<ScopeAgent, "parent" | "spec" | "contract" | "profile">): boolean {
  const contract = a.contract as { review?: unknown; report?: unknown } | null;
  if (contract?.review || contract?.report === true) return false;
  if (a.profile === CONSOLIDATOR_PROFILE) return false;
  return (a.spec as { toolMode?: string } | null)?.toolMode === "orchestrate" || a.parent === null;
}

/**
 * The end of a parkable agent's attempt: its worker parks its machine (src/actors/worker.ts `parkWorker`), then the
 * place's parked machines are kept within the limit. False when it wasn't parked (its place parks none, or the
 * provider refused): the caller destroys the machine as before.
 */
export async function parkAttempt(runId: string, a: ScopeAgent, w: any): Promise<boolean> {
  const RS = await import("../providers/run-sandbox");
  const own = pinnedMachine(a.spec).sandbox ?? null;
  const wk = await w.getWorker({ workerId: a.agentId }).catch(() => null);
  const sandbox: string | null = (typeof wk?.context?.sandbox === "string" && wk.context.sandbox) || (await RS.agentSandbox(runId, own));
  const retentionSeconds = await RS.agentParkedRetention(runId, own, sandbox);
  const r = await w.parkWorker({ workerId: a.agentId, retentionSeconds, runId }).catch((e: unknown) => ({ parked: false, reason: String((e as Error)?.message ?? e) })) as { parked: boolean; deleteAt?: number; reason?: string };
  const log = (line: string) => client().scope.getOrCreate([runId]).appendLog({ agentId: a.agentId, stream: "agent", lines: [line] }).catch(() => {});
  if (!r.parked) {
    if (r.reason && r.reason !== "its place doesn't park machines") await log(`[capcomd] its machine couldn't be parked (${r.reason.slice(0, 200)}): it is deleted, and a message gives it a fresh one`);
    return false;
  }
  await log(`[capcomd] its machine is parked until ${new Date(r.deleteAt ?? Date.now()).toISOString().slice(0, 16).replace("T", " ")} UTC: a message wakes it`);
  let place = sandbox;
  if (!place) { try { place = (await import("../providers/registry")).sandboxName(); } catch { place = null; } }
  if (place) await keepParkedWithinLimit(place);
  return true;
}

/** Deletes one parked machine through its worker (it alone may: a worker that handed it over leaves it alone). */
async function drop(m: AgentMachine & { parked: ParkedMachine }, cause: Exclude<DeleteCause, "action">): Promise<boolean> {
  const r = await client().worker.getOrCreate(m.workerKey).dropParked({ workerId: m.agentId, cause }).catch(() => null) as { dropped?: boolean } | null;
  return !!r?.dropped;
}

/** More than the limit (10) parked at `place`: the oldest go first. Returns the names it deleted. */
export async function keepParkedWithinLimit(place: string, max = parkedMax()): Promise<string[]> {
  const all = parkedMachines({ sandbox: place });
  const gone: string[] = [];
  for (const m of all.slice(0, Math.max(0, all.length - max))) if (await drop(m, "parked_limit")) gone.push(m.name);
  return gone;
}

/** Deletes the parked machines of a run (archived), or of some of its agents and their descendants (cancelled). */
export async function dropParkedOf(runId: string, o: { agentId?: string; agents?: Array<{ agentId: string; parent: string | null }> } = {}, cause: Exclude<DeleteCause, "action"> = "run_ended"): Promise<string[]> {
  const ids = o.agentId ? subtree(o.agents ?? [], o.agentId) : null;
  const gone: string[] = [];
  for (const m of parkedMachines({ runId })) if (!ids || ids.has(m.agentId)) { if (await drop(m, cause)) gone.push(m.name); }
  return gone;
}

/** The user's Delete of a parked machine (Settings › Machines): the machine goes, the agent stays idle (a message gives
 *  it a fresh machine, its conversation restored). False when it isn't parked any more. */
export async function deleteParked(place: string, name: string): Promise<boolean> {
  const m = parkedMachines({ sandbox: place }).find((x) => x.name === name);
  return m ? drop(m, "run_ended") : false;
}
