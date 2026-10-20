import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { type EventFamily, FAMILIES, filterEvents, isProblem, isWaiting } from "../adapters/events";
import type { RunEvent } from "../adapters/types";
import { clock, lpad, pad } from "../format";
import { c } from "../theme";
import { Empty, type ViewProps, compact, dropEntity, windowed } from "./common";

export const eventColor = (e: RunEvent) =>
  isProblem(e) ? c.err : isWaiting(e) ? c.warn : e.type === "run.result" || /merged|completed|approved/.test(e.type) ? c.ok : c.fg;

export function Events({ events, width, height, active, onTyping, initialFamily = "all", initialQuery = "" }: ViewProps & {
  events: RunEvent[]; onTyping?: (t: boolean) => void; initialFamily?: EventFamily; initialQuery?: string;
}) {
  const [family, setFamily] = useState<EventFamily>(initialFamily);
  const [query, setQuery] = useState(initialQuery);
  const [typing, setTypingRaw] = useState(false);
  const [sel, setSel] = useState(0);
  const setTyping = (t: boolean) => { setTypingRaw(t); onTyping?.(t); };
  const shown = useMemo(() => filterEvents(events, family, query), [events, family, query]);
  const t0 = events[0]?.at ?? 0;

  useInput((input, key) => {
    if (typing) {
      if (key.return) setTyping(false);
      else if (key.escape) { setQuery(""); setTyping(false); }
      else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
      setSel(0);
      return;
    }
    if (input === "/") setTyping(true);
    if (input === "f") { setFamily((f) => FAMILIES[(FAMILIES.indexOf(f) + 1) % FAMILIES.length]!); setSel(0); }
    if (input === "F") { setFamily((f) => FAMILIES[(FAMILIES.indexOf(f) + FAMILIES.length - 1) % FAMILIES.length]!); setSel(0); }
    if (key.escape) { setQuery(""); setFamily("all"); }
    if (key.downArrow || input === "j") setSel((s) => Math.min(shown.length - 1, s + 1));
    if (key.upArrow || input === "k") setSel((s) => Math.max(0, s - 1));
    if (input === "G") setSel(shown.length - 1);
    if (input === "g") setSel(0);
  }, { isActive: active });

  const typeW = Math.min(26, Math.max(14, ...events.map((e) => e.type.length + 2)));
  const rows = Math.max(3, height - 8);
  const { start, slice } = windowed(shown, sel, rows);
  const cur = shown[sel];

  return (
    <Box flexDirection="column">
      <Text>
        {FAMILIES.map((f) => (
          <Text key={f} color={f === family ? c.accent : c.dim} bold={f === family}>{f === family ? `[${f}]` : ` ${f} `}{" "}</Text>
        ))}
        <Text color={c.faint}>  </Text>
        <Text color={typing ? c.fg : c.dim}>{typing || query ? `/${query}${typing ? "▏" : ""}` : "/ to search"}</Text>
        <Text color={c.faint}>{`   ${shown.length} of ${events.length}`}</Text>
      </Text>
      <Text> </Text>
      {shown.length === 0 ? <Empty>No events match.</Empty> : slice.map((e, i) => {
        const on = start + i === sel;
        return (
          <Text key={start + i} wrap="truncate">
            <Text color={on ? c.accent : c.faint}>{on ? "›" : " "}</Text>
            <Text color={c.dim}>{lpad(clock(e.at - t0), 9)}  </Text>
            <Text color={eventColor(e)} bold={on}>{pad(e.type, typeW)}</Text>
            <Text color={c.dim}>{pad(e.entity, 10)}  </Text>
            <Text color={c.faint}>{compact(dropEntity(e), Math.max(10, width - typeW - 26))}</Text>
          </Text>
        );
      })}
      <Text color={c.faint}>{"─".repeat(Math.max(0, width - 2))}</Text>
      {cur ? <Text color={c.dim} wrap="truncate">{`${new Date(cur.at).toISOString()}  ${JSON.stringify(cur.data)}`}</Text> : <Text> </Text>}
    </Box>
  );
}
