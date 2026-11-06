// What the evals (scripts/eval-team-shape.ts, scripts/eval-context.ts) kill when they end: whatever still runs from
// their scratch folder (the engine's rivet-engine, a scripted or fake agent), found by the folder in its command line.
// Never the eval itself or its parent: with --work, their command lines name the folder too.
import { spawnSync } from "node:child_process";

/** SIGKILLs every process whose command line names a path under `dir`, except `spare` (this process and its parent). */
export function reapUnder(dir: string, spare: number[] = [process.pid, process.ppid]): number[] {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  const killed: number[] = [];
  for (const l of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    if (!m || !m[2]!.includes(`${dir}/`) || spare.includes(Number(m[1]))) continue;
    try { process.kill(Number(m[1]), "SIGKILL"); killed.push(Number(m[1])); } catch {}
  }
  return killed;
}
