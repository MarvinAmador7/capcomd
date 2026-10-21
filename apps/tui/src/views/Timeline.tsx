import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { type Cell, laneCells, lanesOf } from "../adapters/lanes";
import type { AgentNode, PendingApproval, RunEvent, Trace } from "../adapters/types";
import { axis, dur, pad } from "../format";
import { c } from "../theme";
import { Empty, type ViewProps, windowed } from "./common";

const COLOR: Record<Cell["kind"], string> = { idle: c.faint, infra: c.dim, git: c.fg, agent: c.accent, wait: c.warn, error: c.err };

export function Timeline({ trace, events, agents = [], pending = [], width, height, active }: ViewProps & { trace: Trace | null; events: RunEvent[]; agents?: AgentNode[]; pending?: PendingApproval[] }) {
  const lanes = useMemo(() => (trace ? lanesOf(trace, events, agents, pending) : []), [trace, events, agents, pending]);
  const [sel, setSel] = useState(0);
  useInput((input, key) => {
    if (key.downArrow || input === "j") setSel((s) => Math.min(lanes.length - 1, s + 1));
    if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
  }, { isActive: active });
  if (!trace) return <Empty>No spans yet. Spans appear as they finish (a live view updates every few seconds).</Empty>;

  const labelW = Math.min(30, Math.max(12, ...lanes.map((l) => l.label.length + 2)));
  const trackW = Math.max(10, width - labelW - 14);
  const rows = Math.max(2, Math.floor((height - 8) / 2));
  const { start, slice } = windowed(lanes, sel, rows);
  const cur = lanes[sel];

  return (
    <Box flexDirection="column">
      <Text color={c.faint}>{pad("", labelW + 1)}{axis(trace.durationMs, trackW)}</Text>
      {slice.map((l, i) => {
        const on = start + i === sel;
        const cells = laneCells(l, trace.start, trace.durationMs, trackW);
        return (
          <Box key={l.id} flexDirection="column">
            <Text wrap="truncate">
              <Text color={on ? c.accent : c.faint}>{on ? "›" : " "}</Text>
              <Text color={on ? c.fg : c.dim} bold={on}>{pad(l.label, labelW)}</Text>
              {runs(cells).map((r, k) => <Text key={k} color={COLOR[r.kind]}>{r.text}</Text>)}
              <Text color={l.errors ? c.err : c.dim}>{"  " + (l.busyMs ? dur(l.busyMs) : "")}</Text>
              {l.errorKind ? <Text color={c.err}>{"  ✗ " + l.errorKind}</Text> : null}
            </Text>
            <Text> </Text>
          </Box>
        );
      })}
      <Text>
        <Text color={c.accent}>█ agent  </Text><Text color={c.fg}>▓ git  </Text><Text color={c.dim}>▒ sandbox  ╌ actor  </Text>
        <Text color={c.warn}>░ awaiting approval  </Text><Text color={c.err}>✗ error</Text>
      </Text>
      {cur ? (
        <Text color={c.dim} wrap="truncate">
          <Text color={c.fg} bold>{cur.label}</Text>{`  ${cur.spans.length} spans · agent time ${cur.busyMs ? dur(cur.busyMs) : "—"} · ${cur.waits.length ? `waited ${dur(cur.waits.reduce((a, [x, y]) => a + y - x, 0))} for approval · ` : ""}${cur.errors} errors`}
        </Text>
      ) : null}
    </Box>
  );
}

/** Merge adjacent cells of one kind so each color is one <Text>. */
function runs(cells: Cell[]) {
  const out: Array<{ kind: Cell["kind"]; text: string }> = [];
  for (const cl of cells) {
    const last = out[out.length - 1];
    if (last && last.kind === cl.kind) last.text += cl.ch; else out.push({ kind: cl.kind, text: cl.ch });
  }
  return out;
}
