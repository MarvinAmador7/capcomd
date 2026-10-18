#!/usr/bin/env bun
import { parseArgs } from "util";
import { serve } from "./commands/serve";
import { run } from "./commands/run";
import { status } from "./commands/status";
import { cancel } from "./commands/cancel";
import { replay } from "./commands/replay";
import { trace } from "./commands/trace";
import { ui } from "./commands/ui";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    port: { type: "string", default: "6420" },
    "run-id": { type: "string" },
  },
  allowPositionals: true,
});

const command = positionals[0];

async function main() {
  if (values.help || !command) {
    console.log(`
relay - agent orchestration CLI

Usage:
  relay serve [--port=6420]    Start the Rivet engine
  relay run <goal>              Start a new run
  relay status [runId]          Show run status
  relay cancel <runId>          Cancel a run
  relay replay <runId>          Replay run events
  relay trace <runId>           Show trace timeline/waterfall
  relay ui                      Launch the web UI

Options:
  -h, --help                    Show this help
  --port                        Rivet engine port (default: 6420)
`);
    process.exit(0);
  }

  try {
    switch (command) {
      case "serve":
        await serve({ port: parseInt(values.port as string, 10) });
        break;

      case "run":
        if (!positionals[1]) {
          console.error("Error: goal required");
          process.exit(1);
        }
        await run({
          goal: positionals[1],
          runId: values["run-id"] as string | undefined,
        });
        break;

      case "status":
        await status({ runId: positionals[1] });
        break;

      case "cancel":
        if (!positionals[1]) {
          console.error("Error: runId required");
          process.exit(1);
        }
        await cancel({ runId: positionals[1] });
        break;

      case "replay":
        if (!positionals[1]) {
          console.error("Error: runId required");
          process.exit(1);
        }
        await replay({ runId: positionals[1] });
        break;

      case "trace":
        if (!positionals[1]) {
          console.error("Error: runId required");
          process.exit(1);
        }
        await trace({ runId: positionals[1] });
        break;

      case "ui":
        await ui();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
