import { familyOf } from "./trace";
import type { RunEvent, Span, Trace } from "./types";

export interface Lane { id: string; label: string; spans: Span[]; waits: Array<[number, number]>; errors: number; busyMs: number }

/**
 * One lane per agent (relay.agent_id) or task (relay.task_id); everything else is "run".
 * Approval waits come from task.awaiting_approval → task.approved|task.merged|task.cancelled.
 */
export function lanesOf(trace: Trace, events: RunEvent[] = []): Lane[] {
  const lanes = new Map<string, Lane>();
  const get = (id: string) => lanes.get(id) ?? (lanes.set(id, { id, label: id, spans: [], waits: [], errors: 0, busyMs: 0 }), lanes.get(id)!);
  const owner = new Map<string, string>();
  for (const s of trace.spans) {
    const own = (s.attrs["relay.agent_id"] ?? s.attrs["relay.task_id"]) as string | undefined;
    const id = own ?? (s.parentId ? owner.get(s.parentId) : undefined) ?? "run";
    owner.set(s.id, id);
    if (s.depth === 0 && id === "run" && s.name === "relay.run") continue;
    const l = get(id);
    l.spans.push(s);
    if (s.status === "error") l.errors++;
    if (familyOf(s.name) === "agent") l.busyMs += s.durationMs;
  }
  const open = new Map<string, number>();
  for (const e of events) {
    const t = (e.data.taskId as string) ?? e.entity;
    if (e.type === "task.awaiting_approval") open.set(t, e.at);
    else if (/^task\.(approved|merged|cancelled|skipped)$/.test(e.type) && open.has(t)) {
      const s = open.get(t)!; open.delete(t);
      const lane = lanes.get(t) ?? lanes.get(`agt-${t}`);
      lane?.waits.push([s, e.at]);
    }
  }
  const rest = [...lanes.values()].filter((l) => l.id !== "run").sort((a, b) => (a.spans[0]?.start ?? 0) - (b.spans[0]?.start ?? 0));
  return lanes.has("run") ? [lanes.get("run")!, ...rest] : rest;
}

export interface Cell { ch: string; kind: "idle" | "infra" | "git" | "agent" | "wait" | "error" }
const PRIO: Record<Cell["kind"], number> = { idle: 0, infra: 1, wait: 2, git: 3, agent: 4, error: 5 };

export function laneCells(lane: Lane, t0: number, total: number, width: number): Cell[] {
  const cells: Cell[] = Array.from({ length: width }, () => ({ ch: "─", kind: "idle" as const }));
  const put = (a: number, b: number, cell: Cell) => {
    const i0 = Math.max(0, Math.floor(((a - t0) / total) * width));
    const i1 = Math.min(width - 1, Math.max(i0, Math.ceil(((b - t0) / total) * width) - 1));
    for (let i = i0; i <= i1; i++) if (PRIO[cell.kind] > PRIO[cells[i]!.kind]) cells[i] = cell;
  };
  for (const [a, b] of lane.waits) put(a, b, { ch: "░", kind: "wait" });
  for (const s of lane.spans) {
    const f = familyOf(s.name);
    if (f === "transition" || f === "actor") put(s.start, s.end, { ch: "╌", kind: "infra" });
    else if (f === "sandbox") put(s.start, s.end, { ch: "▒", kind: "infra" });
    else if (f === "git") put(s.start, s.end, { ch: "▓", kind: "git" });
    else if (f === "agent" && s.name !== "agent.install") put(s.start, s.end, { ch: "█", kind: "agent" });
    if (s.status === "error") put(s.end, s.end, { ch: "✕", kind: "error" });
  }
  return cells;
}
