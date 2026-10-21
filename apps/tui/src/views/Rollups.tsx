import { Box, Text } from "ink";
import { BarChart } from "@/components/ui/bar-chart";
import { Sparkline } from "@/components/ui/sparkline";
import { familyOf } from "../adapters/trace";
import { flattenAgents } from "../adapters/tree";
import type { AgentNode, RunData } from "../adapters/types";
import { cost, dur, usd } from "../format";
import { c, familyColor } from "../theme";
import { Section, type ViewProps } from "./common";

export function rollupStats(data: RunData) {
  const agents = flattenAgents(data.agents);
  const spans = data.trace?.spans ?? [];
  const families = new Map<string, number>();
  for (const s of spans) if (s.depth > 0 || s.name !== "relay.run") families.set(familyOf(s.name), (families.get(familyOf(s.name)) ?? 0) + s.durationMs);
  const total = {
    wallMs: data.trace?.durationMs ?? (data.events.length ? data.events[data.events.length - 1]!.at - data.events[0]!.at : 0),
    usd: agents.reduce((a, n) => a + (n.spent.usd ?? 0), 0),
    notionalUsd: agents.reduce((a, n) => a + (n.notionalUsd ?? 0), 0),
    turns: agents.reduce((a, n) => a + (n.spent.turns ?? 0), 0),
    agents: agents.length,
    spans: spans.length,
    errors: spans.filter((s) => s.status === "error").length,
  };
  return { agents, families: [...families.entries()].sort((a, b) => b[1] - a[1]), total };
}

export function Rollups({ data, width }: ViewProps & { data: RunData }) {
  const { agents, families, total } = rollupStats(data);
  const half = Math.max(30, Math.floor((width - 4) / 2));
  const kpis: Array<[string, string, string?]> = [
    ["wall time", dur(total.wallMs)], ["cost", cost(total.usd, total.notionalUsd)], ["turns", String(total.turns)],
    ["agents", String(total.agents)], ["spans", String(total.spans)], ["errors", String(total.errors), total.errors ? c.err : undefined],
  ];
  // Billed spend when there is any; else the API-price estimate of subscription-billed work.
  const billed = total.usd > 0;
  const costOf = (a: AgentNode) => (billed ? a.spent.usd ?? 0 : a.notionalUsd ?? 0);
  const top = agents.slice().sort((a, b) => costOf(b) - costOf(a)).slice(0, 8);
  const buckets = spark(data, 48);
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={4}>
        {kpis.map(([k, v, col]) => (
          <Box key={k} flexDirection="column">
            <Text bold color={col ?? c.fg}>{v}</Text>
            <Text color={c.dim}>{k}</Text>
          </Box>
        ))}
      </Box>
      <Box gap={4}>
        <Box width={half} flexDirection="column">
          <Section title="Cost by agent" hint={!billed && total.notionalUsd > 0 ? "~ API-price estimate · subscription-billed $0" : data.agentsFromTree ? "capcomd tree" : "from agent.cost_usd spans"}>
            {billed || total.notionalUsd > 0 ? <BarChart width={half - 4} data={top.map((a) => ({ label: a.agentId, value: round(costOf(a)) }))} /> : <Text color={c.dim}>No agent.cost_usd recorded for this run.</Text>}
          </Section>
        </Box>
        <Box width={half} flexDirection="column">
          <Section title="Turns by agent">
            {total.turns > 0 ? <BarChart width={half - 6} data={top.map((a) => ({ label: a.agentId, value: a.spent.turns ?? 0, color: c.dim }))} /> : <Text color={c.dim}>No agent.turns recorded for this run.</Text>}
          </Section>
        </Box>
      </Box>
      <Box gap={4}>
        <Box width={half} flexDirection="column">
          <Section title="Time in span family" hint="summed, overlaps counted">
            <BarChart width={half - 4} data={families.filter(([, ms]) => ms >= 100).slice(0, 6).map(([f, ms]) => ({ label: f, value: Math.round(ms / 100) / 10, color: familyColor(f) }))} />
            <Text color={c.faint}>seconds</Text>
          </Section>
        </Box>
        <Box width={half} flexDirection="column">
          <Section title="Activity" hint="spans + events over run time">
            <Sparkline data={buckets} width={Math.min(48, half)} color={c.accent} />
          </Section>
        </Box>
      </Box>
    </Box>
  );
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function spark(data: RunData, n: number): number[] {
  const pts = [...(data.trace?.spans.map((s) => s.start) ?? []), ...data.events.map((e) => e.at)];
  if (pts.length < 2) return [0, 0];
  const a = Math.min(...pts), b = Math.max(...pts), w = Math.max(1, b - a);
  const out = Array(n).fill(0);
  for (const p of pts) out[Math.min(n - 1, Math.floor(((p - a) / w) * n))]++;
  return out.map((x) => Math.log2(1 + x)); // 770 exec calls shouldn't flatten everything else
}
