import { Box, Text } from "ink";
import { Badge } from "@/components/ui/badge";
import { flattenAgents } from "../adapters/tree";
import type { AgentNode, RunData } from "../adapters/types";
import { bar, clock, cost, dur, lpad, pad, usd } from "../format";
import { c, statusColor, statusGlyph } from "../theme";
import { Empty, Section, type ViewProps, compact } from "./common";
import { eventColor } from "./Events";
import { treeRows, type Pipeline, type TreeRow } from "./tree-rows";

export function Live({ data, width, height, live }: ViewProps & { data: RunData; live?: boolean }) {
  const agents = flattenAgents(data.agents);
  const starts = agents.map((a) => a.startedAt).filter((x): x is number => !!x);
  const win = starts.length ? { t0: Math.min(...starts, data.trace?.start ?? Infinity), t1: Math.max(...agents.map((a) => a.endedAt ?? Date.now()).filter(Boolean), data.trace?.end ?? 0) } : null;
    const treeW = Math.max(60, Math.floor(width * 0.66));
  const recent = data.events.slice(-Math.max(4, height - 16));
  const t0 = data.events[0]?.at ?? 0;
  const state = data.state ?? (live ? "running" : "finished");
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={2}>
        <Badge variant={/fail|cancel/.test(state) ? "error" : /complet|done/.test(state) ? "success" : "info"} bordered={false} bold>{`${statusGlyph(state)} ${state}`}</Badge>
        <Text color={c.fg}>{data.goal ?? data.runId}</Text>
        {live ? <Text color={c.accent}>● live</Text> : null}
      </Box>
      <Box gap={3}>
        <Box width={treeW} flexDirection="column">
          <Section title="Agents" hint={data.agentsFromTree ? "capcomd tree" : "inferred from trace"}>
            {agents.length ? treeRows(data.agents, data.events).map((r, i) => <TreeRowView key={i} row={r} width={treeW} win={win} t0={win?.t0 ?? t0} />) : <Empty>No agents yet.</Empty>}
          </Section>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {data.pendingApprovals.length ? (
            <Section title="Awaiting approval">
              {data.pendingApprovals.map((p) => <Text key={p.taskId} color={c.warn}>{`⋯ ${p.taskId}  ${p.kind ?? ""} → ${p.targetBranch ?? ""}  waiting ${dur(Date.now() - p.since)}`}</Text>)}
              <Text> </Text>
            </Section>
          ) : null}
          <Section title="Recent events">
            {recent.length ? recent.map((e, i) => (
              <Text key={i} wrap="truncate">
                <Text color={c.dim}>{lpad(clock(e.at - t0), 8)}  </Text>
                <Text color={eventColor(e)}>{pad(e.type, 23)}</Text>
                <Text color={c.faint}>{compact(e.data, 28)}</Text>
              </Text>
            )) : <Empty>No events.</Empty>}
          </Section>
        </Box>
      </Box>
    </Box>
  );
}

const UNIT_MARK: Record<string, string> = { usd: "$", turns: "t", wallSeconds: "s" };

/**
 * How much of its budget an agent has used, in the unit closest to its limit (the one that stops
 * it). Subscription agents spend $0, so a USD-only meter would stay empty while turns run out.
 */
export function budgetUse(a: Pick<AgentNode, "spent" | "budget">): { frac: number; unit: string } | null {
  let best: { frac: number; unit: string } | null = null;
  for (const unit of ["turns", "wallSeconds", "usd"]) { // ties (e.g. nothing used yet) read as turns
    const cap = a.budget[unit];
    if (!cap || cap <= 0) continue;
    const frac = Math.min(1, (a.spent[unit] ?? 0) / cap);
    if (!best || frac > best.frac) best = { frac, unit };
  }
  return best;
}

function TreeRowView({ row, width, win, t0 }: { row: TreeRow; width: number; win: { t0: number; t1: number } | null; t0: number }) {
  if (row.kind !== "agent") {
    const label = row.kind === "group" ? `parallel ×${row.count}` : row.text;
    return (
      <Text wrap="truncate">
        <Text color={c.faint}>{row.prefix}</Text>
        <Text color={row.kind === "group" ? c.accent : c.dim}>{label}</Text>
        <Text color={c.faint}>{`   ${clock(row.window[0] - t0)} → ${clock(row.window[1] - t0)}`}</Text>
      </Text>
    );
  }
  return <AgentRow a={row.agent} prefix={row.prefix} label={row.label} pipeline={row.pipeline} verdict={row.verdict} width={width} win={win} />;
}

function AgentRow({ a, prefix, label, pipeline, verdict, width, win }: { a: AgentNode; prefix: string; label: string; pipeline: Pipeline | null; verdict: string | null; width: number; win: { t0: number; t1: number } | null }) {
  const laneW = win ? (width >= 130 ? 14 : 10) : 0;
  const nameW = Math.max(16, width - 60 - (win ? laneW + 9 : 0)); // leaves room for "checks✓ review✓ merged✓"
  const use = budgetUse(a);
  const frac = use?.frac ?? 0;
  const meterW = 8;
  const filled = frac > 0 ? Math.max(1, Math.round(frac * meterW)) : 0; // any use shows (3% would round to nothing)
  const id = a.agentId.replace(/^agt-/, "").slice(0, 8);
  const nameRoom = Math.max(4, nameW - prefix.length - 2);
  const showId = label !== a.agentId.replace(/^agt-/, "").slice(0, 10) && label.length + 1 + id.length <= nameRoom;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={c.faint}>{prefix}</Text>
        <Text color={statusColor(a.status)}>{statusGlyph(a.status)} </Text>
        <Text color={a.reviewOf ? c.dim : c.fg}>{showId ? label : pad(label, nameRoom)}</Text>
        {showId ? <Text color={c.faint}>{" " + pad(id, nameRoom - label.length - 1)}</Text> : null}
        <Text> </Text>
        <Text color={c.dim}>{pad(a.profile ?? "", 13)}</Text>
        <Text color={a.spent.usd ? c.fg : c.dim}>{lpad(cost(a.spent.usd, a.notionalUsd), 7)}</Text>
        <Text color={c.dim}>{lpad(`${a.spent.turns ?? 0}t`, 5)}  </Text>
        {win && a.startedAt ? <AgentLane a={a} win={win} w={laneW} /> : win ? <Text>{" ".repeat(laneW + 9)}</Text> : null}
        {pipeline ? <PipelineView p={pipeline} /> : verdict ? <Text color={verdict.startsWith("passed") ? c.ok : c.err}>{verdict}</Text>
          : use ? <Text><Text color={frac > 0.8 ? c.warn : c.accent}>{"▰".repeat(filled)}</Text><Text color={c.faint}>{"▱".repeat(meterW - filled)} {UNIT_MARK[use.unit]}</Text></Text> : null}
      </Text>
      {a.stuck ? <Text color={c.warn}>{"    " + a.stuck}</Text> : null}
      {a.errorKind ? <Text color={c.err}>{"    ✗ " + a.errorKind}</Text> : null}
    </Box>
  );
}

/** checks → review → merge, each only once it happened. */
function PipelineView({ p }: { p: Pipeline }) {
  const step = (name: string, ok: boolean | null) => (ok === null ? null : <Text key={name}><Text color={c.dim}>{name}</Text><Text color={ok ? c.ok : c.err}>{ok ? "✓" : "✗"}</Text><Text> </Text></Text>);
  const merge = p.merged === "merged" ? step("merged", true) : p.merged === "awaiting" ? <Text key="m" color={c.warn}>awaiting approval</Text>
    : p.merged === "denied" ? <Text key="m" color={c.err}>denied</Text> : p.merged === "failed" ? step("merge", false) : null;
  return <Text>{step("checks", p.checks)}{step("review", p.review)}{merge}</Text>;
}

/** Where in the run this agent was alive: start→end on a shared axis, so sub-agents read as nested. */
function AgentLane({ a, win, w }: { a: AgentNode; win: { t0: number; t1: number }; w: number }) {
  const total = Math.max(1, win.t1 - win.t0);
  const end = a.endedAt ?? win.t1;
  const [lead, fill, trail] = bar(a.startedAt! - win.t0, end - win.t0, total, w);
  const col = /fail/.test(a.status) ? c.err : a.endedAt === null || /run/.test(a.status) ? c.accent : c.dim;
  return (
    <Text>
      <Text color={c.faint}>{lead.replace(/ /g, "─")}</Text><Text color={col}>{fill}</Text><Text color={c.faint}>{trail.replace(/ /g, "─")}</Text>
      <Text color={c.dim}>{lpad(dur(end - a.startedAt!), 7)}  </Text>
    </Text>
  );
}
