// observe-runs-index and observe-traces (docs/spec/plugin-api.md §6.6.4, §17.1): the daemon's observers of
// `run.changed`, where `run new` wrote both itself before. A run carries what its creator knew of where it ran (scope
// `getOrigin`: its folder, repository, trace directory and goal branch, src/primitives/ops.ts runNew); once the run is
// created the daemon is told (`created`, from the scope's event log, src/plugins/changes.ts), and:
//  - observe-runs-index appends the run's row to the runs index (src/primitives/ops.ts runsIndexPath; read by
//    `capcomd_runs`, GET /v1/runs, `ctx.runs`), exactly as `run new` wrote it. A run it hasn't recorded yet is recorded
//    the first time it hears of it, so a run created while the daemon's plugins were starting is listed once its run
//    changes again (an agent starts, it ends);
//  - observe-traces records the run's trace directory (`_trace`: where its spans are written, for `capcomd trace` in
//    another shell). The spans themselves are written where they end, by src/utils/tracing-simple.ts, in whichever
//    process ran them (the CLI, the daemon, an agent's capcomd), which needs no plugin host.
// Both are built-ins the kernel runs on (listed, never disabled), loaded in the daemon only: the `*.changed` hooks fire
// there (§6.1).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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

/** Append the run's row unless the index has it: `run new`'s row, from what the run's creator kept with it. A run with
 *  nothing kept (made by an older capcomd, whose `run new` wrote its own row) is left alone. */
export async function indexRun(runId: string): Promise<boolean> {
  const O = await import("../primitives/ops");
  const path = O.runsIndexPath();
  const seen = recordedIn(path);
  if (seen.has(runId)) return false;
  const o = await O.runOrigin(runId);
  if (!o || seen.has(runId)) return false;
  const row: RunRow = { runId, label: o.label, repo: o.repo, cwd: o.cwd, createdAt: o.createdAt, ...(o.goalBranch ? { goalBranch: o.goalBranch } : {}) };
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(row) + "\n"); } catch { return false; /* an index, not state */ }
  seen.add(runId);
  return true;
}

/** Forget what the index was read as (tests that replace the file). */
export function forgetRecorded(): void { recorded.clear(); }

export const runsIndex = definePlugin({
  activate(ctx) {
    // One at a time and in order (the host's observe queue), so a run is never appended twice.
    ctx.hooks.on("run.changed", async ({ payload: { run } }) => { await indexRun(run.id); });
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
