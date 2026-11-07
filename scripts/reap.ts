// What the evals (scripts/eval-team-shape.ts, scripts/eval-context.ts) kill when they end: whatever still runs from
// their scratch folder (the engine's rivet-engine, a scripted or fake agent), found by the folder in its command line.
// Never the eval itself or anything that started it: with --work, their command lines name the folder too (the eval's,
// its parent's, and a shell further up, as in `sh -c 'timeout 3600 bun scripts/eval-team-shape.ts --work DIR'`).
import { spawnSync } from "node:child_process";

/** SIGKILLs every process whose command line names a path under `dir`, except `self` (this process) and every process
 *  it descends from. */
export function reapUnder(dir: string, self: number = process.pid): number[] {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "";
  const rows = ps.split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }] : [];
  });
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const spare = new Set<number>();
  for (let p: number | undefined = self; p !== undefined && p > 1 && !spare.has(p); p = parent.get(p)) spare.add(p);
  if (self === process.pid) spare.add(process.ppid);
  const killed: number[] = [];
  for (const r of rows) {
    if (!r.command.includes(`${dir}/`) || spare.has(r.pid)) continue;
    try { process.kill(r.pid, "SIGKILL"); killed.push(r.pid); } catch {}
  }
  return killed;
}
