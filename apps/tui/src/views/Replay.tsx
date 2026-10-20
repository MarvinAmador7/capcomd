import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { familyOf, waterfallRows } from "../adapters/trace";
import type { RunData } from "../adapters/types";
import { bar, clock, dur, lpad, pad } from "../format";
import { c, familyColor } from "../theme";
import { Empty, type ViewProps, compact, dropEntity } from "./common";
import { eventColor } from "./Events";

const SPEEDS = [1, 2, 5, 10, 30, 60, 120];

/** Scrub through a finished run: spans grow to the playhead, events appear as they happened. */
export function Replay({ data, width, height, active, initialT, initialPlaying = false }: ViewProps & { data: RunData; initialT?: number; initialPlaying?: boolean }) {
  const t0 = Math.min(data.trace?.start ?? Infinity, data.events[0]?.at ?? Infinity);
  const t1 = Math.max(data.trace?.end ?? -Infinity, data.events[data.events.length - 1]?.at ?? -Infinity);
  const total = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(1, t1 - t0) : 0;
  const [t, setT] = useState(initialT ?? 0);
  const [playing, setPlaying] = useState(initialPlaying);
  // Default speed: the whole run replays in ~20 s.
  const [speed, setSpeed] = useState(() => SPEEDS.find((s) => total / s <= 20_000) ?? SPEEDS[SPEEDS.length - 1]!);
  const marks = useMemo(() => data.events.map((e) => e.at - t0), [data.events, t0]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setT((x) => { const n = x + 100 * speed; if (n >= total) { setPlaying(false); return total; } return n; }), 100);
    return () => clearInterval(id);
  }, [playing, speed, total]);

  useInput((input, key) => {
    if (input === " ") { if (t >= total) setT(0); setPlaying((p) => !p); }
    if (key.rightArrow || input === "l") setT((x) => marks.find((m) => m > x + 1) ?? total);
    if (key.leftArrow || input === "h") setT((x) => [...marks].reverse().find((m) => m < x - 1) ?? 0);
    if (input === "]") setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)]!);
    if (input === "[") setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)]!);
    if (input === "0") { setT(0); setPlaying(false); }
  }, { isActive: active });

  if (!total) return <Empty>Nothing to replay.</Empty>;
  const now = t0 + t;
  const trackW = Math.max(20, width - 40);
  const rows = data.trace ? waterfallRows(data.trace).filter((r) => r.span.depth <= 2 && r.start <= now).slice(0, Math.max(3, height - 18)) : [];
  const seen = data.events.filter((e) => e.at <= now);
  const head = Math.min(trackW - 1, Math.floor((t / total) * trackW));

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={playing ? c.accent : c.fg} bold>{playing ? "▶ playing" : t >= total ? "■ end" : "❚❚ paused"}</Text>
        <Text color={c.fg}>{`   ${dur(t)}`}</Text><Text color={c.dim}>{` / ${dur(total)}   ${speed}×`}</Text>
      </Text>
      <Text>
        <Text color={c.accent}>{"━".repeat(head)}</Text><Text color={c.fg}>●</Text><Text color={c.faint}>{"─".repeat(Math.max(0, trackW - head - 1))}</Text>
      </Text>
      <Text color={c.faint}>{markLine(marks, total, trackW)}</Text>
      <Text> </Text>
      {rows.map((r) => {
        const end = Math.min(r.end, now);
        const running = r.end > now;
        const [lead, fill] = bar(r.start - t0, end - t0, total, trackW);
        const err = r.errors > 0 && !running;
        return (
          <Text key={r.key} wrap="truncate">
            <Text color={running ? c.fg : c.dim}>{pad(`${"  ".repeat(r.span.depth)}${r.span.name}${r.count > 1 ? ` ×${r.count}` : ""}`, 30)}</Text>
            <Text color={c.dim}>{lpad(running ? "…" : dur(r.end - r.start), 8)} </Text>
            <Text>{lead}</Text>
            <Text color={err ? c.err : running ? c.accent : r.count > 1 ? c.faint : familyColor(familyOf(r.span.name))}>{fill}</Text>
          </Text>
        );
      })}
      <Text> </Text>
      {seen.slice(-6).map((e, i, arr) => (
        <Text key={i} wrap="truncate">
          <Text color={c.dim}>{lpad(clock(e.at - t0), 9)}  </Text>
          <Text color={eventColor(e)} bold={i === arr.length - 1}>{pad(e.type, 24)}</Text>
          <Text color={c.faint}>{compact(dropEntity(e), width - 40)}</Text>
        </Text>
      ))}
    </Box>
  );
}

function markLine(marks: number[], total: number, w: number) {
  const cells = Array(w).fill(" ");
  for (const m of marks) cells[Math.min(w - 1, Math.floor((m / total) * w))] = "╵";
  return cells.join("");
}
