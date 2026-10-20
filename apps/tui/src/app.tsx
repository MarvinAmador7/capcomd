import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useState } from "react";
import { ThemeContext } from "@/hooks/use-theme";
import type { RunData } from "./adapters/types";
import { dur, usd } from "./format";
import { c, capcomTheme, statusColor, statusGlyph } from "./theme";
import { Events } from "./views/Events";
import { Live } from "./views/Live";
import { Replay } from "./views/Replay";
import { Rollups, rollupStats } from "./views/Rollups";
import { Timeline } from "./views/Timeline";
import { Waterfall } from "./views/Waterfall";

export const TABS = [
  { key: "live", label: "Live", hint: "agent tree and status" },
  { key: "waterfall", label: "Waterfall", hint: "j/k move · enter unfold ×N · z fold all · g/G ends" },
  { key: "timeline", label: "Timeline", hint: "j/k lane" },
  { key: "rollups", label: "Rollups", hint: "cost, turns and time" },
  { key: "events", label: "Events", hint: "f/F family · / search · esc clear · j/k move" },
  { key: "replay", label: "Replay", hint: "space play · ←/→ event · [ ] speed · 0 restart" },
] as const;
export type TabKey = (typeof TABS)[number]["key"];

export interface AppProps {
  data: RunData;
  initialTab?: TabKey;
  width?: number;
  height?: number;
  /** Re-fetch for live runs; called every `pollMs`. */
  reload?: () => Promise<RunData>;
  pollMs?: number;
  replayT?: number;
  eventsFamily?: Parameters<typeof Events>[0]["initialFamily"];
}

export function App({ data: initial, initialTab = "waterfall", width: w, height: h, reload, pollMs = 2000, replayT, eventsFamily }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [typing, setTyping] = useState(false);
  const width = w ?? Math.max(80, (stdout?.columns ?? 120) - 2);
  const height = h ?? Math.max(24, (stdout?.rows ?? 36) - 1);

  useEffect(() => {
    if (!reload) return;
    let stop = false;
    const tick = async () => { try { const d = await reload(); if (!stop) setData(d); } catch {} };
    const id = setInterval(tick, pollMs);
    return () => { stop = true; clearInterval(id); };
  }, [reload, pollMs]);

  useInput((input, key) => {
    if (typing) return;
    if (input === "q" || (key.ctrl && input === "c")) exit();
    const n = Number(input);
    if (n >= 1 && n <= TABS.length) setTab(TABS[n - 1]!.key);
    const i = TABS.findIndex((t) => t.key === tab);
    if (key.tab && !key.shift) setTab(TABS[(i + 1) % TABS.length]!.key);
    if (key.tab && key.shift) setTab(TABS[(i + TABS.length - 1) % TABS.length]!.key);
  });

  const body = height - 5;
  const vp = { width, height: body, active: !typing || tab === "events" };
  const { total } = rollupStats(data);
  const state = data.state ?? (reload ? "running" : "finished");
  const cur = TABS.find((t) => t.key === tab)!;

  return (
    <ThemeContext.Provider value={{ theme: capcomTheme, setTheme: () => {} }}>
      <Box flexDirection="column" width={width} height={height}>
        <Box justifyContent="space-between">
          <Text>
            <Text color={c.accent}>◆ </Text><Text bold color={c.fg}>capcomd</Text>
            <Text color={c.dim}>{"  " + data.runId + "  "}</Text>
            <Text color={statusColor(state)}>{statusGlyph(state)} {state}</Text>
          </Text>
          <Text color={c.dim}>{`${dur(total.wallMs)} · ${usd(total.usd)} · ${total.turns} turns   `}<Text color={c.faint}>{data.source}</Text></Text>
        </Box>
        <Box gap={3}>
          {TABS.map((t, i) => (
            <Text key={t.key}>
              <Text color={c.faint}>{i + 1} </Text>
              <Text color={t.key === tab ? c.accent : c.dim} bold={t.key === tab} underline={t.key === tab}>{t.label}</Text>
            </Text>
          ))}
        </Box>
        <Text color={c.faint}>{"─".repeat(width - 2)}</Text>
        <Box flexDirection="column" height={body} overflow="hidden">
          {tab === "live" && <Live data={data} {...vp} live={!!reload} />}
          {tab === "waterfall" && <Waterfall trace={data.trace} {...vp} />}
          {tab === "timeline" && <Timeline trace={data.trace} events={data.events} {...vp} />}
          {tab === "rollups" && <Rollups data={data} {...vp} />}
          {tab === "events" && <Events events={data.events} {...vp} active onTyping={setTyping} initialFamily={eventsFamily} />}
          {tab === "replay" && <Replay data={data} {...vp} initialT={replayT} />}
        </Box>
        <Text color={c.faint}>{`${cur.hint}   ·   1–6 or tab switch view · q quit`}</Text>
      </Box>
    </ThemeContext.Provider>
  );
}
