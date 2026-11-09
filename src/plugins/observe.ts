// observe-runs-index and observe-traces (docs/spec/plugin-api.md §6.6.4, §17.1): the daemon's observers of
// `run.changed`, where `run new` wrote both itself before. `run new`'s last step keeps with the run what its process
// knew of where it ran (scope `setOrigin`, read back with `getOrigin`: its folder, repository, trace directory and goal
// branch, src/primitives/ops.ts runNew) and tells the daemon's plugins the run was created (`created`,
// src/plugins/changes.ts tellCreated); a run whose `run new` failed partway is told so only when a retry finishes it. Then:
//  - observe-runs-index appends the run's row to the runs index its creator lists runs from (src/primitives/ops.ts
//    runsIndexPath, in `run new`'s process; read by `capcomd_runs`, GET /v1/runs, `ctx.runs`), exactly as `run new`
//    wrote it there, when that file is a runs index (isRunsIndex), else to the daemon's own. A run it hasn't recorded
//    yet is recorded
//    the first time it hears of it, so a run created while the daemon's plugins were starting is listed once its run
//    changes again (an agent starts, it ends);
//  - observe-traces records the run's trace directory (`_trace`: where its spans are written, for `capcomd trace` in
//    another shell). The spans themselves are written where they end, by src/utils/tracing-simple.ts, in whichever
//    process ran them (the CLI, the daemon, an agent's capcomd), which needs no plugin host.
// Both are built-ins the kernel runs on (listed, never disabled), loaded in the daemon only: the `*.changed` hooks fire
// there (§6.1).
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { RunRow } from "../primitives/ops";
import { VERSION } from "../utils/self";

export const runsIndexManifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "observe-runs-index", version: VERSION,
  description: "Keeps the list of runs this machine created (state/runs.jsonl): each run's folder, repository, goal branch and when it was created, for the run list and capcomd_runs.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./observe.ts" }, scopes: ["read"],
  contributes: { hooks: { "run.changed": {} } },
};

export const tracesManifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "observe-traces", version: VERSION,
  description: "Records where each run's trace is written, so capcomd trace finds it from any shell.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./observe.ts" }, scopes: ["read"],
  contributes: { hooks: { "run.changed": {} } },
};

/** The runs this daemon knows the index has, per index file (read from it once, then kept as rows are written). */
const recorded = new Map<string, Set<string>>();
function recordedIn(path: string): Set<string> {
  let s = recorded.get(path);
  if (!s) {
    s = new Set<string>();
    try {
      if (existsSync(path)) for (const l of readFileSync(path, "utf8").split("\n")) { try { if (l) s.add((JSON.parse(l) as RunRow).runId); } catch { /* a torn line */ } }
    } catch { /* an index, not state: an unreadable one is written to as if empty */ }
    recorded.set(path, s);
  }
  return s;
}

/** Runs this daemon has settled (recorded, found recorded, or with nothing kept), so each is looked up once. */
const settled = new Set<string>();

/**
 * Whether `path`, another process's runs index (its CAPCOMD_RUNS_INDEX), is one the daemon appends a row to: an absolute
 * `.jsonl` path in a folder that exists, not a link, and missing, empty or a runs index already (its first line a row).
 * Anyone who reaches the engine can say where a run's creator lists runs from (scope `setOrigin`), so the daemon never
 * appends to another kind of file, nor makes a folder for one: `run new` makes its index's folder itself.
 */
export function isRunsIndex(path: string): boolean {
  if (!isAbsolute(path) || resolve(path) !== path || !path.endsWith(".jsonl")) return false;
  try {
    if (!statSync(dirname(path)).isDirectory()) return false;
    let st;
    try { st = lstatSync(path); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
    if (!st.isFile()) return false;
    if (st.size === 0) return true;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(4096);
      const first = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8").split("\n")[0]!;
      const row = JSON.parse(first) as Partial<RunRow> | null;
      return !!row && typeof row === "object" && typeof row.runId === "string";
    } finally { closeSync(fd); }
  } catch { return false; }
}

/** Append the run's row unless its index has it: `run new`'s row, from what the run's creator kept with it. A run with
 *  nothing kept (made by an older capcomd, whose `run new` wrote its own row, or not finished yet) is left alone; its
 *  `created` (`fresh`) looks it up again. */
export async function indexRun(runId: string, opts: { fresh?: boolean } = {}): Promise<boolean> {
  const O = await import("../primitives/ops");
  if (opts.fresh) settled.delete(runId);
  const own = O.runsIndexPath();
  if (settled.has(runId) || recordedIn(own).has(runId)) return false;
  const o = await O.runOrigin(runId);
  if (!o) { settled.add(runId); return false; }
  // The index its creator lists runs from (where its `run new` wrote the row itself) when it is one, else this daemon's.
  const path = o.index && o.index !== resolve(own) && isRunsIndex(o.index) ? o.index : own;
  const seen = recordedIn(path);
  if (seen.has(runId)) { settled.add(runId); return false; }
  const row: RunRow = { runId, label: o.label, repo: o.repo, cwd: o.cwd, createdAt: o.createdAt, ...(o.goalBranch ? { goalBranch: o.goalBranch } : {}) };
  try { if (path === own) mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(row) + "\n"); } catch { return false; /* an index, not state */ }
  seen.add(runId);
  settled.add(runId);
  return true;
}

export const runsIndex = definePlugin({
  activate(ctx) {
    // One at a time and in order (the host's observe queue), so a run is never appended twice.
    ctx.hooks.on("run.changed", async ({ payload: { run, change } }) => { await indexRun(run.id, { fresh: change.kind === "created" }); });
  },
});

export const traces = definePlugin({
  activate(ctx) {
    ctx.hooks.on("run.changed", async ({ payload: { run, change } }) => {
      if (change.kind !== "created") return;
      const O = await import("../primitives/ops");
      const o = await O.runOrigin(run.id);
      if (!o) return;
      await (await import("../primitives/state")).kvWrite(run.id, { k: O.TRACE_KV, value: { dir: o.traceDir }, writer: "operator" }).catch(() => {});
    });
  },
});
