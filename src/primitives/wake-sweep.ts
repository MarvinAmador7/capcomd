// ADR-026 §3: the daemon's start-up sweep for ops an armed wake waits on.
//
// A verify, check or merge runs in the daemon's process; when the daemon goes away mid-op, the op's record stays
// "running" until someone picks it up again. A polling waiter (`capcomd verify` without --wake) does that on its next
// look; an agent that armed a wake on the op isn't polling, so nothing would, and its wake would wait for its deadline.
// So each run with an op wake leaves a marker here (stateDir()/wakes/<runId>), and the daemon, once it is up with its
// plugins (their gates judge the op), restarts each running op an armed wake waits on, as a waiter would (`resumeOp`:
// idempotent, the op's record says where it got to). A marker whose run has no armed op wake left is removed.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../utils/home";

const dir = () => join(stateDir(), "wakes");
const RUN_ID = /^run-[A-Za-z0-9_-]{1,120}$/;

/** A wake on an op of this run was armed: the next start-up looks at the run. */
export function noteOpWake(runId: string): void {
  if (!RUN_ID.test(runId)) return;
  try { mkdirSync(dir(), { recursive: true, mode: 0o700 }); writeFileSync(join(dir(), runId), ""); } catch { /* best effort: a waiter can still restart it */ }
}

/** Restart every running op an armed wake waits on, in the runs that have one. Returns how many it restarted. */
export async function resumeWaitedOps(): Promise<number> {
  if (!existsSync(dir())) return 0;
  const { existingActor } = await import("../core/relay");
  const O = await import("./ops");
  let n = 0;
  for (const runId of readdirSync(dir()).filter((f) => RUN_ID.test(f))) {
    let s: any;
    try { s = await existingActor("scope", [runId]); } catch { continue; } // the engine didn't answer: the next start looks again
    if (!s) { rmSync(join(dir(), runId), { force: true }); continue; }
    const armed = ((await s.wakeList({ state: "armed" }).catch(() => null)) ?? null) as Array<{ filter: { kind: string } }> | null;
    if (armed === null) continue;
    if (!armed.some((w) => w.filter.kind === "op")) { rmSync(join(dir(), runId), { force: true }); continue; }
    for (const op of (await s.wakeOps({}).catch(() => [])) as any[]) {
      O.resumeOp(runId, op).catch(() => { /* its record says how it ended; the wake fires on that */ });
      n++;
    }
  }
  return n;
}
