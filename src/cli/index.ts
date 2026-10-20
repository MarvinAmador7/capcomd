#!/usr/bin/env bun
import "./quiet";
import { parseArgs } from "util";
import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "fs";
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
capcomd - agent orchestration CLI

Usage:
  capcomd serve                          Start the Rivet engine (port 6420)
  capcomd run <goal> [--run-id ID] [--target-branch B] [--detach]
             [--profile NAME] [--set key=value]... [--overrides JSON] [--operator]
                                       Pick an agent profile; overrides only narrow it
                                       (e.g. --set children.maxDepth=1 --set maxTurns=10)
                                       unless --operator
                                       Start or resume a run
  capcomd status <runId>                 Show run status
  capcomd cancel <runId>                 Cancel a run
  capcomd events <runId> [--cursor N] [--limit N]
                                       List lifecycle events (alias: replay)
  capcomd trace <runId>                  Show the span waterfall
  capcomd approve <runId> <taskId>       Approve a merge parked in awaiting_approval
  capcomd env build [--force]            Bake agent CLIs + repo deps into a boxd snapshot (no secrets)
  capcomd env status | env rm [name|all] List / delete env snapshots
  capcomd agents list|show|add|set|rm|schema|validate
  Primitives (ADR-016; all --json, stable ids, --key idempotent):
  capcomd run new [--budget 5|usd=5,turns=200,wallSeconds=3600] [--label L] [--key K]                     → runId (a scope; plans nothing)
  capcomd spawn <runId> --task T [--profile P] [--set k=v] [--parent agt] [--key K] [--budget usd=…,turns=…,wallSeconds=…] [--contract JSON|file] [--no-start] [--operator]
  capcomd await <runId> <agt…> [--timeout-ms N]  ·  capcomd wait-any <runId> <agt…>
  capcomd cancel <runId> [agt] [--reason R]     (propagates to all descendants)  ·  capcomd tree <runId>
  capcomd verify <runId> --ref <agt|branch> [--checks CMD] [--acceptance JSON|file] [--judge-profile P] [--target T] [--key K]  → vfy-…
  capcomd merge <runId> --ref <agt|branch> --require <vfyId> [--target T] [--operator] [--key K]   (only the verified commit lands)
  capcomd task add <runId> --title T [--data JSON] [--after tsk,…] [--key K]  ·  task list <runId> [--status open|claimed|done]  ·  task show <runId> <tsk>
  capcomd task claim <runId> [tsk] --holder H [--lease-ms N] [--key K]   → {taskId, epoch, leaseUntil}; no id = next free (expired leases are taken over)
  capcomd task renew|release|done <runId> <tsk> --holder H --epoch E [--lease-ms N] [--result JSON] [--key K]   (fenced: a stale epoch is rejected)
  capcomd kv get <runId> <k>  ·  kv put <runId> <k> <json> [--key K]  ·  kv cas <runId> <k> <json> --expect V [--key K]  ·  kv del <runId> <k> [--expect V]  ·  kv list <runId> [--prefix P] [--all]   (values ≤ 64KB)
  capcomd events <runId> --follow [--until TYPE] [--timeout-ms N] [--from-start]   (with --json: one JSON event per line)
                                       Named agent profiles (.capcomd/agents.json): provider, auth
                                       (apikey|subscription, exactly one), model, limits, prompts, tools.
                                       add/set flags: --provider --auth --model --max-turns --budget
                                       --timeout-ms --sandbox --egress --system-prompt
                                       --append-system-prompt --allowed-tools --disallowed-tools
                                       --description --default --spec JSON --unset k1,k2
  capcomd auth login claude|codex        Log in with your Claude/ChatGPT plan in a VM; saves a private auth profile
  capcomd auth status [agent] [--quick]  Verify saved logins   |   capcomd auth logout claude|codex
  capcomd secrets sync                   Store local ANTHROPIC/OPENAI keys as boxd host-bound secrets
  capcomd doctor                         Check agents + credentials inside a snapshot VM
  capcomd mcp                            Serve the capcomd tools over MCP (stdio)
  capcomd ui                             Launch the web UI

Options:
  --json        Machine-readable output (schema "${SCHEMA}"); run streams NDJSON
  --detach      With run: start in the background and print {runId}
  -h, --help    Show this help

Exit codes: 0 ok, 1 run failed, 2 usage, 3 not found, 4 engine unreachable
`;

function deepMerge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const o: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" ? deepMerge(o[k], v) : v;
  return o;
}

function usage(message: string): never {
  throw new RelayError("usage", message, "Run `capcomd --help` for usage.");
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
        force: { type: "boolean" },
        quick: { type: "boolean" },
        agent: { type: "string" },
        profile: { type: "string" },
        set: { type: "string", multiple: true },
        overrides: { type: "string" },
        operator: { type: "boolean" },
        provider: { type: "string" },
        auth: { type: "string" },
        model: { type: "string" },
        "max-turns": { type: "string" },
        budget: { type: "string" },
        "timeout-ms": { type: "string" },
        sandbox: { type: "string" },
        egress: { type: "string" },
        "system-prompt": { type: "string" },
        "append-system-prompt": { type: "string" },
        "allowed-tools": { type: "string" },
        "disallowed-tools": { type: "string" },
        description: { type: "string" },
        default: { type: "boolean" },
        spec: { type: "string" },
        unset: { type: "string" },
        task: { type: "string" },
        parent: { type: "string" },
        key: { type: "string" },
        contract: { type: "string" },
        reason: { type: "string" },
        label: { type: "string" },
        "no-start": { type: "boolean" },
        ref: { type: "string" },
        checks: { type: "string" },
        acceptance: { type: "string" },
        "judge-profile": { type: "string" },
        require: { type: "string" },
        target: { type: "string" },
        holder: { type: "string" },
        epoch: { type: "string" },
        "lease-ms": { type: "string" },
        title: { type: "string" },
        data: { type: "string" },
        result: { type: "string" },
        expect: { type: "string" },
        follow: { type: "boolean" },
        until: { type: "string" },
        status: { type: "string" },
        prefix: { type: "string" },
        "from-start": { type: "boolean" },
        after: { type: "string", multiple: true },
        all: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const err = new RelayError("usage", error instanceof Error ? error.message : String(error), "Run `capcomd --help` for usage.");
    const wantsJson = argv.includes("--json");
    if (wantsJson) console.log(JSON.stringify(err.toJSON()));
    else console.error(`Error: ${err.message}\n${err.hint}`);
    return err.exitCode;
  }
  const { values, positionals } = parsed;
  const json = !!values.json;
  const command = positionals[0];
  const jsonish = (v: unknown) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };
  const out = (obj: Record<string, unknown>) => console.log(JSON.stringify({ schema: SCHEMA, ok: true, ...obj }));

  try {
    if (values.help || !command) {
      console.log(HELP);
      return command || values.help ? EXIT.ok : EXIT.usage;
    }

    switch (command) {
      case "env":
      case "secrets":
      case "auth":
      case "doctor": {
        const { envCommand } = await import("./commands/env");
        return await envCommand(command, positionals, values as any);
      }
      case "agents": {
        const { agentsCommand } = await import("./commands/agents");
        return await agentsCommand(positionals, values as any);
      }
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
        if (positionals[1] === "new" && positionals.length === 2) {
          const { parseBudget } = await import("../primitives/policy");
          let budget: Record<string, number> = { usd: 10 };
          try { if (values.budget !== undefined) budget = parseBudget(values.budget); } catch (e) { usage(`--budget: ${(e as Error).message} (e.g. 5 or usd=5,turns=200,wallSeconds=3600)`); }
          const P = await import("../primitives/ops");
          const r = await P.runNew({ budget, label: values.label as string | undefined, key: values.key as string | undefined, runId: values["run-id"] as string | undefined });
          if (json) out(r); else console.log(r.runId);
          return EXIT.ok;
        }
        const rawGoal = positionals[1];
        if (!rawGoal) usage("goal required: capcomd run <goal>");
        // --profile/--agent NAME [--set k=v …] [--overrides JSON] [--operator] becomes the goal directive
        // the planner/worker/preflight read. Overrides may only narrow the profile unless --operator.
        const agentFlag = (values.profile ?? values.agent) as string | undefined;
        const sets = (values.set as string[] | undefined) ?? [];
        if ((sets.length || values.overrides || values.operator) && !agentFlag) usage("--set/--overrides/--operator need --profile NAME");
        let goal = rawGoal;
        if (agentFlag) {
          if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(agentFlag)) usage(`invalid --profile ${agentFlag}`);
          const P = await import("../agents/profiles");
          let set: Record<string, unknown> = {};
          try {
            if (values.overrides) set = JSON.parse(values.overrides as string);
            set = deepMerge(set, P.parseSetPairs(sets));
          } catch (e) { usage(`bad override: ${(e as Error).message}`); }
          const ref = P.encodeAgentRef(agentFlag, { set, operator: !!values.operator });
          try { P.resolveAgent(ref); } catch (e) { throw new RelayError("config", (e as Error).message, "Overrides may only narrow the profile (fewer turns/budget/tools/egress, stricter sandbox, smaller children limits); pass --operator to widen deliberately."); }
          if (!/^\s*\[agent:/i.test(rawGoal)) goal = `[agent:${ref}] ${rawGoal}`;
        }
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
        const runId = positionals[1] ?? usage("runId required: capcomd status <runId>");
        const s = await getStatus(runId);
        if (json) out({ run: s });
        else {
          console.log(`Run: ${s.runId}\nState: ${s.state}\nGoal: ${s.goal}`);
          console.log(`Budget: $${s.budget.spent.toFixed(4)} / $${s.budget.maxCost.toFixed(2)}`);
          if (s.tasks.length) {
            console.log(`\nTasks:`);
            for (const t of s.tasks) console.log(`  ${t.taskId}: ${t.state}${t.targetBranch ? ` → ${t.targetBranch}` : ""}`);
          }
          if (s.awaitingApproval.length) console.log(`\nAwaiting approval: ${s.awaitingApproval.join(", ")}  (capcomd approve ${s.runId} <taskId>)`);
          console.log(`\nEvents: ${s.events} total`);
        }
        return EXIT.ok;
      }

      case "spawn": {
        const runId = positionals[1] ?? usage("runId required: capcomd spawn <runId> --task TEXT [--profile P] [--parent agt] [--key K]");
        const task = (values.task as string | undefined) ?? positionals[2] ?? usage("--task required");
        const profile = (values.profile ?? values.agent) as string | undefined;
        const sets = (values.set as string[] | undefined) ?? [];
        let set: Record<string, unknown> = {};
        try {
          if (values.overrides) set = JSON.parse(values.overrides as string);
          set = deepMerge(set, (await import("../agents/profiles")).parseSetPairs(sets));
        } catch (e) { usage(`bad override: ${(e as Error).message}`); }
        if ((Object.keys(set).length) && !profile) usage("--set/--overrides need --profile NAME");
        let contract: Record<string, unknown> | undefined;
        if (values.contract) {
          const raw = String(values.contract);
          try { contract = JSON.parse(raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8")); } catch (e) { usage(`bad --contract (JSON or a JSON file): ${(e as Error).message}`); }
        }
        let budget: Record<string, number> | undefined;
        try { if (values.budget !== undefined) budget = (await import("../primitives/policy")).parseBudget(values.budget); } catch (e) { usage(`--budget: ${(e as Error).message}`); }
        const P = await import("../primitives/ops");
        const r = await P.spawnAgent({
          runId, task, ...(profile ? { profile } : {}), ...(Object.keys(set).length || values.operator ? { overrides: { set, operator: !!values.operator } } : {}),
          parent: values.parent as string | undefined, key: values.key as string | undefined, contract, budget,
          operator: !!values.operator, start: !values["no-start"],
        });
        if (json) out(r); else console.log(r.agentId);
        return EXIT.ok;
      }

      case "await":
      case "wait-any": {
        const runId = positionals[1] ?? usage(`runId required: capcomd ${command} <runId> <agentId…>`);
        const ids = positionals.slice(2);
        if (!ids.length) usage(`agent ids required: capcomd ${command} <runId> <agentId…>`);
        const timeoutMs = values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined;
        const P = await import("../primitives/ops");
        const r: any = await P.awaitAgents(runId, ids, { timeoutMs, any: command === "wait-any" });
        if (json) out(r);
        else for (const a of r.agents) console.log(`${a.agentId}: ${a.status}${a.result?.commit ? ` ${String(a.result.commit).slice(0, 12)}` : ""}${a.result?.error ? ` (${a.result.error})` : ""}`);
        if (r.timeout) return EXIT.run_failed;
        const relevant = command === "wait-any" ? [r.first] : r.agents;
        return relevant.every((a: any) => a.status === "done") ? EXIT.ok : EXIT.run_failed;
      }

      case "verify": {
        const runId = positionals[1] ?? usage("runId required: capcomd verify <runId> --ref <agt|branch> [--checks CMD] [--acceptance JSON|file] [--judge-profile P]");
        const ref = (values.ref as string | undefined) ?? positionals[2] ?? usage("--ref required (an agent id or a branch)");
        let acceptance: unknown;
        if (values.acceptance) {
          const raw = String(values.acceptance);
          try { acceptance = raw.trim().startsWith("{") || raw.trim().startsWith("[") ? JSON.parse(raw) : existsSync(raw) ? JSON.parse(readFileSync(raw, "utf8")) : raw; } catch (e) { usage(`bad --acceptance: ${(e as Error).message}`); }
        }
        const r: any = await (await import("../primitives/ops")).verifyRef({
          runId, ref, checks: values.checks as string | undefined, acceptance, judgeProfile: values["judge-profile"] as string | undefined,
          target: values.target as string | undefined, key: values.key as string | undefined,
        });
        if (json) out(r);
        else console.log(`${r.id}: ${r.state}${r.result?.commit ? ` (${String(r.result.commit).slice(0, 12)})` : ""}${r.result?.checks?.reason ? ` ${r.result.checks.reason}` : ""}`);
        return r.state === "passed" ? EXIT.ok : EXIT.run_failed;
      }

      case "merge": {
        const runId = positionals[1] ?? usage("runId required: capcomd merge <runId> --ref <agt|branch> --require <vfyId> [--target T]");
        const ref = (values.ref as string | undefined) ?? positionals[2] ?? usage("--ref required (an agent id or a branch)");
        const r: any = await (await import("../primitives/ops")).mergeRef({
          runId, ref, require: values.require as string | undefined, target: values.target as string | undefined,
          operator: !!values.operator, key: values.key as string | undefined,
        });
        if (json) out(r);
        else console.log(`${r.id}: ${r.state}${r.result?.sha ? ` ${String(r.result.sha).slice(0, 12)}` : ""}${r.result?.reason ? ` ${r.result.reason}` : ""}`);
        return r.state === "merged" ? EXIT.ok : EXIT.run_failed;
      }

      case "tree": {
        const runId = positionals[1] ?? usage("runId required: capcomd tree <runId>");
        const r = await (await import("../primitives/ops")).listScope(runId);
        if (json) out(r);
        else {
          const b = (x: Record<string, number>) => Object.entries(x).map(([k, v]) => `${k}=${v}`).join(",") || "-";
          console.log(`${runId}  budget ${b(r.budget)} (unallocated ${b(r.unallocated)}, spent ${b(r.spent)})`);
          for (const a of r.agents) console.log(`${"  ".repeat(a.depth + 1)}${a.agentId} [${a.profile ?? "-"}] ${a.status} budget ${b(a.budget)} spent ${b(a.spent)}${a.parent ? ` ← ${a.parent}` : ""}`);
        }
        return EXIT.ok;
      }

      case "agent-drive": {
        const runId = positionals[1] ?? usage("capcomd agent-drive <runId> <agentId>");
        const agentId = positionals[2] ?? usage("capcomd agent-drive <runId> <agentId>");
        const a = await (await import("../primitives/ops")).driveAgent(runId, agentId);
        if (json) out({ agent: a }); else console.log(`${agentId}: ${a.status}`);
        return a.status === "done" ? EXIT.ok : EXIT.run_failed;
      }

      case "cancel": {
        const runId = positionals[1] ?? usage("runId required: capcomd cancel <runId> [agentId]");
        const P = await import("../primitives/ops");
        const scoped = await P.listScope(runId).then(() => true, () => false);
        if (positionals[2] || scoped) {
          const r = await P.cancelAgents(runId, positionals[2], values.reason as string | undefined);
          if (json) out(r);
          else console.log(r.cancelled.length ? `✓ cancelled ${r.cancelled.join(", ")}` : `nothing to cancel (${r.affected.map((a: { agentId: string; status: string }) => `${a.agentId}=${a.status}`).join(", ") || "no agents"})`);
          return EXIT.ok;
        }
        const r = await cancelRun(runId);
        if (json) out(r);
        else console.log(r.changed ? `✓ Run ${runId} cancelled` : `Run ${runId} is ${r.state}; nothing to cancel`);
        return EXIT.ok;
      }

      case "task": {
        const S = await import("../primitives/state");
        const sub = positionals[1];
        const runId = positionals[2] ?? usage("usage: capcomd task add|claim|renew|release|done|list|show <runId> …");
        const holder = () => (values.holder as string | undefined) ?? usage("--holder required (who holds the lease, e.g. your agent id)");
        const epoch = () => { const e = Number(values.epoch); if (!Number.isInteger(e) || e < 1) usage("--epoch required: the epoch your claim returned"); return e; };
        const lease = values["lease-ms"] !== undefined ? Number(values["lease-ms"]) : undefined;
        const key = values.key as string | undefined;
        let r: Record<string, unknown>;
        if (sub === "add") r = await S.taskAdd(runId, { title: (values.title as string | undefined) ?? positionals[3] ?? usage("--title required"), data: jsonish(values.data), key, after: ((values.after as string[] | undefined) ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean) });
        else if (sub === "claim") r = await S.taskClaim(runId, { holder: holder(), taskId: positionals[3], leaseMs: lease, key });
        else if (sub === "renew") r = await S.taskRenew(runId, { taskId: positionals[3] ?? usage("task id required"), holder: holder(), epoch: epoch(), leaseMs: lease });
        else if (sub === "release" || sub === "done") r = await S.taskFinish(runId, { taskId: positionals[3] ?? usage("task id required"), holder: holder(), epoch: epoch(), outcome: sub === "done" ? "done" : "released", result: jsonish(values.result), key });
        else if (sub === "list") r = await S.taskList(runId, values.status as string | undefined);
        else if (sub === "show") r = { ...(await S.taskGet(runId, positionals[3] ?? usage("task id required"))) };
        else return usage("usage: capcomd task add|claim|renew|release|done|list|show <runId> …");
        if (json) out(r);
        else if (sub === "list") for (const t of (r.tasks as any[])) console.log(`${t.taskId}  ${t.status}${t.expired ? "(expired)" : ""}${t.blockedBy?.length ? `(blocked by ${t.blockedBy.join(",")})` : ""}  ${t.holder ?? "-"}  e${t.epoch}  ${t.title}`);
        else console.log(JSON.stringify(r, null, 2));
        return EXIT.ok;
      }

      case "kv": {
        const S = await import("../primitives/state");
        const sub = positionals[1];
        const runId = positionals[2] ?? usage("usage: capcomd kv get|put|cas|list <runId> …");
        const k = () => positionals[3] ?? usage("key name required");
        const val = () => { const v = positionals[4] ?? (values.data as string | undefined); if (v === undefined) usage("value required (JSON, or a plain string)"); return jsonish(v); };
        let r: Record<string, unknown>;
        if (sub === "get") r = await S.kvGet(runId, k());
        else if (sub === "put") r = await S.kvWrite(runId, { k: k(), value: val(), writer: values.holder as string | undefined, key: values.key as string | undefined });
        else if (sub === "cas") {
          const e = values.expect === undefined ? usage("--expect V required (the version you read; 0 = must not exist)") : Number(values.expect);
          r = await S.kvWrite(runId, { k: k(), value: val(), expect: e, writer: values.holder as string | undefined, key: values.key as string | undefined });
        } else if (sub === "del" || sub === "delete") {
          r = await S.kvWrite(runId, { k: k(), value: null, del: true, ...(values.expect !== undefined ? { expect: Number(values.expect) } : {}), writer: values.holder as string | undefined, key: values.key as string | undefined });
        } else if (sub === "list") r = await S.kvList(runId, values.prefix as string | undefined, !!values.all);
        else return usage("usage: capcomd kv get|put|cas|del|list <runId> …");
        if (json) out(r);
        else if (sub === "list") for (const e of (r.entries as any[])) console.log(`${e.k}  v${e.version}  ${JSON.stringify(e.value)}`);
        else console.log(JSON.stringify(r, null, 2));
        return EXIT.ok;
      }

      case "events":
      case "replay": {
        const runId = positionals[1] ?? usage(`runId required: capcomd ${command} <runId>`);
        if (values.follow) {
          const S = await import("../primitives/state");
          const r = await S.followEvents(runId, {
            until: values.until as string | undefined, fromStart: !!values["from-start"],
            timeoutMs: values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : undefined,
            emit: (ev) => json ? out({ runId, event: ev }) : console.log(`[${ev.entity.padEnd(20)}] ${new Date(ev.at).toISOString()} ${JSON.stringify(ev.event)}`),
          });
          if (json) out({ runId, end: r });
          return EXIT.ok;
        }
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
        const runId = positionals[1] ?? usage("runId required: capcomd trace <runId>");
        const tree = loadTrace(runId);
        if (!tree) throw new RelayError("not_found", `No trace found for run ${runId}`, "Traces are written to .traces/<runId>.ndjson while a run executes; start one with `capcomd run`.");
        if (json) out({ trace: tree });
        else console.log(renderTrace(tree));
        return EXIT.ok;
      }

      case "approve": {
        const runId = positionals[1] ?? usage("usage: capcomd approve <runId> <taskId>");
        const taskId = positionals[2] ?? usage("usage: capcomd approve <runId> <taskId>");
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
