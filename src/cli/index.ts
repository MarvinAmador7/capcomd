#!/usr/bin/env bun
import "./quiet";
import { parseArgs } from "util";
import { spawn } from "child_process";
import { mkdirSync, openSync } from "fs";
import { join, resolve } from "path";
import { serve } from "./commands/serve";
import { ui } from "./commands/ui";
import { loadTrace, renderTrace } from "./commands/trace";
import { RelayError, SCHEMA, EXIT, toRelayError } from "../core/errors";
import {
  approveTask,
  assertEngine,
  cancelRun,
  executeRun,
  generateRunId,
  getStatus,
  listEvents,
  paginate,
} from "../core/relay";
import { initDependencies } from "../dependencies";

const HELP = `
relay - agent orchestration CLI

Usage:
  relay serve                          Start the Rivet engine (port 6420)
  relay run <goal> [--run-id ID] [--target-branch B] [--detach]
                                       Start or resume a run
  relay status <runId>                 Show run status
  relay cancel <runId>                 Cancel a run
  relay events <runId> [--cursor N] [--limit N]
                                       List lifecycle events (alias: replay)
  relay trace <runId>                  Show the span waterfall
  relay approve <runId> <taskId>       Approve a merge parked in awaiting_approval
  relay mcp                            Serve the relay tools over MCP (stdio)
  relay ui                             Launch the web UI

Options:
  --json        Machine-readable output (schema "${SCHEMA}"); run streams NDJSON
  --detach      With run: start in the background and print {runId}
  -h, --help    Show this help

Exit codes: 0 ok, 1 run failed, 2 usage, 3 not found, 4 engine unreachable
`;

function usage(message: string): never {
  throw new RelayError("usage", message, "Run `relay --help` for usage.");
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        detach: { type: "boolean" },
        port: { type: "string", default: "6420" },
        "run-id": { type: "string" },
        "target-branch": { type: "string" },
        cursor: { type: "string" },
        limit: { type: "string" },
        by: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const err = new RelayError("usage", error instanceof Error ? error.message : String(error), "Run `relay --help` for usage.");
    const wantsJson = argv.includes("--json");
    if (wantsJson) console.log(JSON.stringify(err.toJSON()));
    else console.error(`Error: ${err.message}\n${err.hint}`);
    return err.exitCode;
  }
  const { values, positionals } = parsed;
  const json = !!values.json;
  const command = positionals[0];
  const out = (obj: Record<string, unknown>) => console.log(JSON.stringify({ schema: SCHEMA, ok: true, ...obj }));

  try {
    if (values.help || !command) {
      console.log(HELP);
      return command || values.help ? EXIT.ok : EXIT.usage;
    }

    switch (command) {
      case "serve":
        await serve({ port: parseInt(values.port as string, 10) });
        return EXIT.ok;

      case "ui":
        await ui();
        return EXIT.ok;

      case "mcp": {
        const { runMcpServer } = await import("../mcp/server");
        await runMcpServer();
        return EXIT.ok;
      }

      case "run": {
        const goal = positionals[1];
        if (!goal) usage("goal required: relay run <goal>");
        const runId = (values["run-id"] as string | undefined) ?? generateRunId();
        const targetBranch = values["target-branch"] as string | undefined;
        await assertEngine();

        if (values.detach) {
          const dir = resolve(new URL("../..", import.meta.url).pathname, ".relay", "runs");
          mkdirSync(dir, { recursive: true });
          const log = join(dir, `${runId}.ndjson`);
          const fd = openSync(log, "a");
          const args = [new URL(import.meta.url).pathname, "run", "--json", "--run-id", runId];
          if (targetBranch) args.push("--target-branch", targetBranch);
          args.push(goal);
          const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
          child.unref();
          if (json) out({ runId, detached: true, log, pid: child.pid });
          else console.log(`Started run ${runId} in the background (log: ${log})`);
          return EXIT.ok;
        }

        initDependencies();
        const result = await executeRun({
          goal,
          runId,
          targetBranch,
          emit: (type, data, human) => {
            if (json) console.log(JSON.stringify({ schema: SCHEMA, type, runId, ts: new Date().toISOString(), ...data }));
            else console.log(human);
          },
        });
        if (json) console.log(JSON.stringify({ schema: SCHEMA, type: "run.result", runId, ts: new Date().toISOString(), ok: result.ok, state: result.state }));
        return result.ok ? EXIT.ok : EXIT.run_failed;
      }

      case "status": {
        const runId = positionals[1] ?? usage("runId required: relay status <runId>");
        const s = await getStatus(runId);
        if (json) out({ run: s });
        else {
          console.log(`Run: ${s.runId}\nState: ${s.state}\nGoal: ${s.goal}`);
          console.log(`Budget: $${s.budget.spent.toFixed(4)} / $${s.budget.maxCost.toFixed(2)}`);
          if (s.tasks.length) {
            console.log(`\nTasks:`);
            for (const t of s.tasks) console.log(`  ${t.taskId}: ${t.state}${t.targetBranch ? ` → ${t.targetBranch}` : ""}`);
          }
          if (s.awaitingApproval.length) console.log(`\nAwaiting approval: ${s.awaitingApproval.join(", ")}  (relay approve ${s.runId} <taskId>)`);
          console.log(`\nEvents: ${s.events} total`);
        }
        return EXIT.ok;
      }

      case "cancel": {
        const runId = positionals[1] ?? usage("runId required: relay cancel <runId>");
        const r = await cancelRun(runId);
        if (json) out(r);
        else console.log(r.changed ? `✓ Run ${runId} cancelled` : `Run ${runId} is ${r.state}; nothing to cancel`);
        return EXIT.ok;
      }

      case "events":
      case "replay": {
        const runId = positionals[1] ?? usage(`runId required: relay ${command} <runId>`);
        const limit = values.limit ? Number.parseInt(values.limit as string, 10) : 1000;
        if (!Number.isFinite(limit) || limit < 1) usage("--limit must be a positive integer");
        const all = await listEvents(runId);
        const page = paginate(all, values.cursor as string | undefined, limit);
        if (json) out({ runId, events: page.items, nextCursor: page.nextCursor, total: page.total, truncated: page.nextCursor !== null });
        else {
          console.log(`Events for ${runId}: ${page.total} total\n`);
          for (const ev of page.items) console.log(`[${ev.entity.padEnd(20)}] ${new Date(ev.at).toISOString()} ${JSON.stringify(ev.event)}`);
          if (page.nextCursor) console.log(`\n… more: --cursor ${page.nextCursor}`);
        }
        return EXIT.ok;
      }

      case "trace": {
        const runId = positionals[1] ?? usage("runId required: relay trace <runId>");
        const tree = loadTrace(runId);
        if (!tree) throw new RelayError("not_found", `No trace found for run ${runId}`, "Traces are written to .traces/<runId>.ndjson while a run executes; start one with `relay run`.");
        if (json) out({ trace: tree });
        else console.log(renderTrace(tree));
        return EXIT.ok;
      }

      case "approve": {
        const runId = positionals[1] ?? usage("usage: relay approve <runId> <taskId>");
        const taskId = positionals[2] ?? usage("usage: relay approve <runId> <taskId>");
        const r = await approveTask(runId, taskId, (values.by as string | undefined) ?? "cli");
        if (json) out(r);
        else console.log(r.already ? `${taskId} was already merged` : `✓ Approved ${taskId}; merging into protected branch`);
        return EXIT.ok;
      }

      default:
        usage(`unknown command: ${command}`);
    }
  } catch (error) {
    const err = toRelayError(error);
    if (json) console.log(JSON.stringify(err.toJSON()));
    else console.error(`\n✗ ${err.message}\n  ${err.hint}`);
    return err.exitCode;
  }
}

const code = await main(process.argv.slice(2));
if (code !== 0 || !["serve", "ui", "mcp"].includes(process.argv[2] ?? "")) process.exit(code);
