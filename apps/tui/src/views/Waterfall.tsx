import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { familyOf, waterfallRows } from "../adapters/trace";
import type { Trace } from "../adapters/types";
import { axis, bar, dur, lpad, pad } from "../format";
import { c, familyColor } from "../theme";
import { Empty, type ViewProps, windowed } from "./common";

const DETAIL_KEYS = ["relay.task_id", "relay.agent_id", "agent.profile", "agent.turns", "agent.cost_usd", "agent.billing", "agent.stop_reason", "git.sha", "git.ref", "git.operation", "relay.state_from", "relay.state_to", "sandbox.vm_id", "relay.actor"];

export function Waterfall({ trace, width, height, active }: ViewProps & { trace: Trace | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0);
  const rows = useMemo(() => (trace ? waterfallRows(trace, expanded) : []), [trace, expanded]);

  useInput((input, key) => {
    if (key.downArrow || input === "j") setSel((s) => Math.min(rows.length - 1, s + 1));
    if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
    if (input === "g") setSel(0);
    if (input === "G") setSel(rows.length - 1);
    if (key.pageDown) setSel((s) => Math.min(rows.length - 1, s + 10));
    if (key.pageUp) setSel((s) => Math.max(0, s - 10));
    if (key.return || input === " ") {
      const r = rows[sel];
      if (r && r.count > 1) setExpanded((e) => new Set(e).add(r.key));
    }
    if (input === "z") setExpanded(new Set());
  }, { isActive: active });

  if (!trace) return <Empty>No trace for this run. Traces are written to .traces/&lt;runId&gt;.ndjson while a run executes.</Empty>;

  const nameW = Math.min(38, Math.max(24, Math.floor(width * 0.3)));
  const durW = 8;
  const trackW = Math.max(10, width - nameW - durW - 4);
  const listRows = Math.max(3, height - 9);
  const { start, slice } = windowed(rows, sel, listRows);
  const cur = rows[sel];

  return (
    <Box flexDirection="column">
      <Text color={c.faint}>{pad("", nameW + 1)}{lpad("", durW)}  {axis(trace.durationMs, trackW)}</Text>
      {slice.map((r, i) => {
        const idx = start + i;
        const on = idx === sel;
        const fam = familyOf(r.span.name);
        const err = r.errors > 0;
        const label = `${"  ".repeat(r.span.depth)}${r.span.name}${r.count > 1 ? ` ×${r.count}` : ""}`;
        const [lead, fill, trail] = bar(r.start - trace.start, r.end - trace.start, trace.durationMs, trackW);
        const barColor = err ? c.err : r.count > 1 ? c.faint : familyColor(fam);
        return (
          <Text key={r.key} wrap="truncate">
            <Text color={on ? c.accent : c.faint}>{on ? "›" : " "}</Text>
            <Text color={on ? c.fg : r.span.depth <= 1 ? c.fg : c.dim} bold={on}>{pad(label, nameW)}</Text>
            <Text color={err ? c.err : c.dim}>{lpad(dur(r.durationMs), durW)}</Text>
            <Text color={c.faint}>  </Text>
            <Text color={c.faint}>{lead.replace(/ /g, on ? "·" : " ")}</Text>
            <Text color={barColor}>{fill}</Text>
            <Text>{trail}</Text>
          </Text>
        );
      })}
      <Text color={c.faint}>{"─".repeat(Math.max(0, width - 2))}</Text>
      {cur ? <Detail row={cur} traceStart={trace.start} width={width} /> : null}
    </Box>
  );
}

function Detail({ row, traceStart, width }: { row: ReturnType<typeof waterfallRows>[number]; traceStart: number; width: number }) {
  const s = row.span;
  const kv = DETAIL_KEYS.filter((k) => s.attrs[k] !== undefined).map((k) => `${k.replace(/^(relay|agent|git|sandbox)\./, "")} ${String(s.attrs[k])}`);
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={c.fg}>{s.name}</Text>
        {row.count > 1 ? <Text color={c.dim}>{`  ${row.count} calls · ${dur(row.durationMs)} busy · enter to unfold`}</Text> : null}
        <Text color={row.errors ? c.err : c.ok}>{row.errors ? `  ✕ ${row.errors > 1 ? row.errors + " errors" : "error"}` : "  ✓ ok"}</Text>
      </Text>
      <Text color={c.dim}>{`starts +${dur(row.start - traceStart)}  ·  lasts ${dur(row.end - row.start)}  ·  ${s.events.length} events  ·  span ${s.id}`}</Text>
      <Text color={c.dim} wrap="truncate">{kv.join("   ") || " "}</Text>
      {s.message ? <Text color={c.err} wrap="truncate">{s.message.slice(0, width * 2)}</Text> : <Text> </Text>}
    </Box>
  );
}
