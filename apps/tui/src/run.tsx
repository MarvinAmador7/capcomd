// The terminal debugger as a function: `capcomd tui` (src/cli) and this app's own main.tsx both call it.
import { render } from "ink";
import { parseArgs } from "node:util";
import { followLive, listFixtures, loadFixture, loadLive, setCli } from "./adapters/source";
import { App, TABS, type TabKey } from "./app";
import { ICON_SETS, type IconSet } from "./icons";

export const TUI_HELP = `capcomd tui — watch and debug a capcomd run

  capcomd tui [runId]                   live: the run's agents, waterfall, timeline, rollups and events
                                        (no runId: the most recent run)
  --icons glyph|nerd|minimal|none       waterfall icons (nerd needs a Nerd Font)
  --view live|waterfall|timeline|rollups|events|replay
  --fixture NAME, --list                a bundled demo run (from a checkout)`;

/** Runs the TUI; `cli` is how to run capcomd for the live views (default: CAPCOMD_BIN or this checkout's). */
export async function runTui(args: string[], o: { cli?: string[]; latestRun?: () => string | null } = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      fixture: { type: "string", short: "f" },
      run: { type: "string", short: "r" },
      view: { type: "string", short: "v" },
      list: { type: "boolean" },
      icons: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) { console.log(TUI_HELP); return 0; }
  if (values.list) { console.log(listFixtures().join("\n")); return 0; }
  if (o.cli) setCli(o.cli);
  const icons = (ICON_SETS.includes(values.icons as IconSet) ? values.icons : "glyph") as IconSet;
  const view = (TABS.some((t) => t.key === values.view) ? values.view : undefined) as TabKey | undefined;
  const runId = values.run ?? positionals[0] ?? (values.fixture ? undefined : o.latestRun?.() ?? undefined);
  // From the CLI with no run to show: say so (the demo fixtures ship with a checkout only).
  if (!runId && !values.fixture && o.latestRun) { console.error("capcomd tui: no runs yet. Start one (capcomd run new, or capcomd run \"<goal>\"), then run capcomd tui."); return 1; }
  if (runId) {
    const data = await loadLive(runId);
    const app = render(<App data={data} subscribe={(set) => followLive(runId, set)} initialTab={view ?? "live"} icons={icons} />);
    await app.waitUntilExit();
  } else {
    const app = render(<App data={loadFixture(values.fixture ?? "demo-3-tasks")} initialTab={view ?? "waterfall"} icons={icons} />);
    await app.waitUntilExit();
  }
  return 0;
}
