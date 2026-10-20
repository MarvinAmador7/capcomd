#!/usr/bin/env bun
import { render } from "ink";
import { parseArgs } from "node:util";
import { listFixtures, loadFixture, loadLive } from "./adapters/source";
import { App, TABS, type TabKey } from "./app";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    fixture: { type: "string", short: "f" },
    run: { type: "string", short: "r" },
    view: { type: "string", short: "v" },
    list: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`capcomd-tui — debug a capcomd run

  bun run start                         demo fixture
  bun run start --fixture task-timeout  a bundled fixture (--list to see all)
  bun run start --run <runId>           live: polls capcomd trace/events/tree every 2s
  --view live|waterfall|timeline|rollups|events|replay

  CAPCOMD_BIN overrides the CLI (default: bun <repo>/src/cli/index.ts)`);
  process.exit(0);
}
if (values.list) { console.log(listFixtures().join("\n")); process.exit(0); }

const view = (TABS.some((t) => t.key === values.view) ? values.view : undefined) as TabKey | undefined;
if (values.run) {
  const runId = values.run;
  const data = await loadLive(runId);
  render(<App data={data} reload={() => loadLive(runId)} initialTab={view ?? "live"} />);
} else {
  render(<App data={loadFixture(values.fixture ?? "demo-3-tasks")} initialTab={view ?? "waterfall"} />);
}
