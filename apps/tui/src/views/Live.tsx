import { Box, Text } from "ink";
import { Badge } from "@/components/ui/badge";
import { flattenAgents } from "../adapters/tree";
import type { AgentNode, RunData } from "../adapters/types";
import { clock, lpad, pad, usd } from "../format";
import { c, statusColor, statusGlyph } from "../theme";
import { Empty, Section, type ViewProps, compact } from "./common";
import { eventColor } from "./Events";

export function Live({ data, width, height, live }: ViewProps & { data: RunData; live?: boolean }) {
  const agents = flattenAgents(data.agents);
    const treeW = Math.max(50, Math.floor(width * 0.58));
  const recent = data.events.slice(-Math.max(4, height - 16));
  const t0 = data.events[0]?.at ?? 0;
  const state = data.state ?? (live ? "running" : "finished");
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={2}>
        <Badge variant={/fail|cancel/.test(state) ? "error" : /complet/.test(state) ? "success" : "info"} bordered={false} bold>{`● ${state}`}</Badge>
        <Text color={c.fg}>{data.goal ?? data.runId}</Text>
        {live ? <Text color={c.accent}>● live</Text> : null}
      </Box>
      <Box gap={3}>
        <Box width={treeW} flexDirection="column">
          <Section title="Agents" hint={data.agentsFromTree ? "capcomd tree" : "inferred from trace"}>
            {agents.length ? agents.map((a) => <AgentRow key={a.agentId} a={a} width={treeW} />) : <Empty>No agents yet.</Empty>}
          </Section>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
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

function AgentRow({ a, width }: { a: AgentNode; width: number }) {
  const indent = a.depth > 0 ? "  ".repeat(a.depth - 1) + "└ " : "";
  const nameW = Math.max(18, width - 44);
  const frac = a.budget.usd ? Math.min(1, (a.spent.usd ?? 0) / a.budget.usd) : 0;
  const meterW = 8;
  const filled = Math.round(frac * meterW);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={statusColor(a.status)}>{statusGlyph(a.status)} </Text>
        <Text color={c.faint}>{indent}</Text>
        <Text color={c.fg}>{pad(a.agentId, nameW - indent.length)}</Text>
        <Text color={c.dim}>{pad(a.profile ?? "", 10)}</Text>
        <Text color={c.fg}>{lpad(usd(a.spent.usd), 7)}</Text>
        <Text color={c.dim}>{lpad(`${a.spent.turns ?? 0}t`, 5)}  </Text>
        {a.budget.usd ? <Text><Text color={frac > 0.8 ? c.warn : c.accent}>{"▰".repeat(filled)}</Text><Text color={c.faint}>{"▱".repeat(meterW - filled)}</Text></Text> : null}
      </Text>
      {a.stuck ? <Text color={c.warn}>{"    " + a.stuck}</Text> : null}
    </Box>
  );
}
