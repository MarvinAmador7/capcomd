import { Box, Text } from "ink";
import { Badge } from "@/components/ui/badge";
import { flattenAgents } from "../adapters/tree";
import type { AgentNode, RunData } from "../adapters/types";
import { bar, clock, dur, lpad, pad, usd } from "../format";
import { c, statusColor, statusGlyph } from "../theme";
import { Empty, Section, type ViewProps, compact } from "./common";
import { eventColor } from "./Events";

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
            {agents.length ? agents.map((a) => <AgentRow key={a.agentId} a={a} width={treeW} win={win} />) : <Empty>No agents yet.</Empty>}
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

function AgentRow({ a, width, win }: { a: AgentNode; width: number; win: { t0: number; t1: number } | null }) {
  const indent = a.depth > 0 ? "  ".repeat(a.depth - 1) + "└ " : "";
  const laneW = win ? 14 : 0;
  const nameW = Math.max(16, width - 46 - (win ? laneW + 9 : 0));
  const frac = a.budget.usd ? Math.min(1, (a.spent.usd ?? 0) / a.budget.usd) : 0;
  const meterW = 8;
  const filled = Math.round(frac * meterW);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={statusColor(a.status)}>{statusGlyph(a.status)} </Text>
        <Text color={c.faint}>{indent}</Text>
        <Text color={c.fg}>{pad(a.agentId, nameW - indent.length - 1)} </Text>
        <Text color={c.dim}>{pad(a.profile ?? "", 10)}</Text>
        <Text color={c.fg}>{lpad(usd(a.spent.usd), 7)}</Text>
        <Text color={c.dim}>{lpad(`${a.spent.turns ?? 0}t`, 5)}  </Text>
        {win && a.startedAt ? <AgentLane a={a} win={win} w={laneW} /> : win ? <Text>{" ".repeat(laneW + 9)}</Text> : null}
        {a.budget.usd ? <Text><Text color={frac > 0.8 ? c.warn : c.accent}>{"▰".repeat(filled)}</Text><Text color={c.faint}>{"▱".repeat(meterW - filled)}</Text></Text> : null}
      </Text>
      {a.stuck ? <Text color={c.warn}>{"    " + a.stuck}</Text> : null}
      {a.errorKind ? <Text color={c.err}>{"    ✗ " + a.errorKind}</Text> : null}
    </Box>
  );
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
