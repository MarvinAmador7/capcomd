#!/usr/bin/env bun
import { render } from "ink";
import { parseArgs } from "node:util";
import { followLive, listFixtures, loadFixture, loadLive } from "./adapters/source";
import { App, TABS, type TabKey } from "./app";
import { ICON_SETS, type IconSet } from "./icons";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
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

if (values.help) {
  console.log(`capcomd-tui — debug a capcomd run

  bun run start                         demo fixture
  bun run start --fixture task-timeout  a bundled fixture (--list to see all)
  bun run start --run <runId>           live: follows capcomd inspect <runId> --json --follow
  --icons glyph|nerd|minimal|none   waterfall icons (nerd needs a Nerd Font)
  --view live|waterfall|timeline|rollups|events|replay

  CAPCOMD_BIN overrides the CLI (default: bun <repo>/src/cli/index.ts)`);
  process.exit(0);
}
if (values.list) { console.log(listFixtures().join("\n")); process.exit(0); }

const icons = (ICON_SETS.includes(values.icons as IconSet) ? values.icons : "glyph") as IconSet;
const view = (TABS.some((t) => t.key === values.view) ? values.view : undefined) as TabKey | undefined;
if (values.run) {
  const runId = values.run;
  const data = await loadLive(runId);
  render(<App data={data} subscribe={(set) => followLive(runId, set)} initialTab={view ?? "live"} icons={icons} />);
} else {
  render(<App data={loadFixture(values.fixture ?? "demo-3-tasks")} initialTab={view ?? "waterfall"} icons={icons} />);
}
