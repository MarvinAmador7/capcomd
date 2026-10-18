import ELK from "elkjs/lib/elk-api";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { RelayGraph } from "./graph-fold";

export type Positions = Record<string, { x: number; y: number }>;

export const NODE_W = 150;
export const NODE_H = 50;

/** Build the ELK input. Edges go from parent to child, so runs sit above their tasks. */
export function toElkGraph(graph: RelayGraph): ElkNode {
  const nodes = Object.values(graph.nodes);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [
    ...(graph.edges ?? []).map((e: any) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    ...nodes
      .filter((n) => n.parentId && ids.has(n.parentId))
      .map((n) => ({ id: `p-${n.parentId}-${n.id}`, sources: [n.parentId!], targets: [n.id] })),
  ].filter((e) => ids.has(e.sources[0]!) && ids.has(e.targets[0]!));
  // A task with no parent link still belongs under the run, so ELK layers it below.
  const run = nodes.find((n) => n.data?.type === "run");
  if (run) {
    const linked = new Set(edges.map((e) => e.targets[0]));
    for (const n of nodes) {
      if (n.id !== run.id && !linked.has(n.id)) edges.push({ id: `r-${n.id}`, sources: [run.id], targets: [n.id] });
    }
  }
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
    },
    children: nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges,
  };
}

export function positionsFrom(laid: ElkNode): Positions {
  const out: Positions = {};
  for (const c of laid.children ?? []) {
    if (Number.isFinite(c.x) && Number.isFinite(c.y)) out[c.id] = { x: c.x!, y: c.y! };
  }
  return out;
}

export type WorkerFactory = () => Worker;

export const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("../workers/layout.worker.ts", import.meta.url), { type: "module" });

/** ELK running in a real Web Worker. Rejects if the worker fails; callers log and fall back. */
export function createElkLayout(factory: WorkerFactory = defaultWorkerFactory) {
  let worker: Worker | null = null;
  const elk = new ELK({
    workerFactory: () => {
      worker = factory();
      return worker as any;
    },
  });
  return {
    async layout(graph: RelayGraph): Promise<Positions> {
      try {
        return positionsFrom(await elk.layout(toElkGraph(graph)));
      } catch (e) {
        throw e instanceof Error ? e : new Error(`ELK worker error: ${String(e)}`);
      }
    },
    terminate() {
      elk.terminateWorker();
      worker = null;
    },
  };
}
