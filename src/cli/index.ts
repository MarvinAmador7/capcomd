#!/usr/bin/env bun
import "./apply-config";
import "./quiet";
import { parseArgs } from "util";
import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { serve } from "./commands/serve";
import { ui } from "./commands/ui";
import { loadTrace, renderTrace } from "./commands/trace";
import { RelayError, SCHEMA, EXIT, toRelayError } from "../core/errors";

/** Which `capcomd run <goal>` path runs by default (ADR-016 step 4). */
export const DEFAULT_RUN_PATH: "recipe" | "legacy" = "recipe";
import {
  approveTask,
  assertEngine,
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
  capcomd serve [--harness-socket PATH]  Start the Rivet engine (port 6420) and the harness.v1 API socket
  capcomd run <goal> [--run-id ID] [--target-branch B] [--detach]
             [--profile NAME] [--set key=value]... [--overrides JSON] [--operator]
                                       Pick an agent profile; overrides only narrow it
                                       (e.g. --set children.maxDepth=1 --set maxTurns=10)
                                       unless --operator
                                       Start or resume a run (EXPERIMENTAL: the recipe's planner
                                       and judge still use a fake model; see STATUS.md)
  capcomd status <runId>                 Show run status
  capcomd cancel <runId>                 Cancel a run
  capcomd events <runId> [--cursor N] [--limit N]
                                       List lifecycle events (alias: replay)
  capcomd trace <runId>                  Show the span waterfall
  capcomd approve <runId> <taskId|mrgId> [--deny] [--reason R]
                                       Approve (or deny) a merge parked in awaiting_approval
  capcomd env build [--force]            Bake agent CLIs + repo deps into a snapshot (no secrets)
  capcomd env status | env rm [name|all] List / delete env snapshots (env, auth, doctor: --sandbox docker|boxd
                                       works on that sandbox instead of CAPCOMD_SANDBOX)
  capcomd agents list|show|add|set|rm|schema|validate
  Primitives (ADR-016; all --json, stable ids, --key idempotent):
  capcomd run <goal> [--planner PROFILE]   a planner agent splits the goal into child agents, verifies and merges their work
                                           (default on boxd: the profile named "planner", which capcomd setup writes)
             [--planner-provider claude|codex]  run the planner on that provider (its model and login: the project's
                                           profile on it, else the provider's defaults)
             [--planner-effort LEVEL]      the planner's reasoning effort (claude low..max, codex minimal..high)
             [--sandbox docker|boxd]       where this run's agents and checks run (default: CAPCOMD_SANDBOX)
  capcomd run <goal> [--recipe|--legacy]   (CAPCOMD_RUN_PATH) the built-in flow with a placeholder planner: offline and tests
  capcomd clients add <name> [--scopes read,steer,approve] | list | revoke <id>   harness.v1 API tokens (shown once; steer: start, pause/resume/cancel runs, messages)
  capcomd run new [--budget 5|usd=5,turns=200,wallSeconds=3600] [--label L] [--goal G] [--key K] [--checks-set name='cmd']… [--reviewer PROFILE] [--target T [--target-from BASE]]  → runId (a scope; plans nothing)
  capcomd spawn <runId> --task T [--profile P] [--set k=v] [--parent agt] [--key K] [--budget usd=…,turns=…,wallSeconds=…] [--contract JSON|file] [--check NAME] [--report] [--continue agt] [--no-start] [--operator]
  capcomd await <runId> <agt…> [--timeout-ms N] [--notices]  ·  capcomd wait-any <runId> <agt…> [--notices]
  capcomd cancel <runId> [agt] [--reason R]     (propagates to all descendants)  ·  capcomd tree <runId>
  capcomd pause <runId> [agt]                   pause agents (and their descendants): each stops with its work kept on its branch
  capcomd resume <runId> [agt]                  run paused agents (and their paused descendants) again now (paused with \`capcomd pause\` or by a provider usage limit)
  capcomd grant <runId> [agt] --budget usd=…,turns=…,wallSeconds=… [--key K]   give a live agent more budget (from its parent's), or raise the run's
  capcomd verify <runId> --ref <agt|branch> [--check NAME | --checks CMD] [--acceptance JSON|file] [--review-profile P] [--target T] [--key K]  → vfy-…
                                       (checks, then the reviewer agent: the run's --reviewer or --review-profile; both must pass)
  capcomd merge <runId> --ref <agt|branch> --require <vfyId> [--target T] [--operator] [--key K]   (only the verified commit lands)
  ADR-017 sub-agents (agents allowed to spawn get the same verbs in their VM as \`capcomd\` + MCP tools):
  capcomd spawn … [--children.maxChildren=N --children.maxDepth=N --children.maxTotalDescendants=N --children.allowedChildProfiles=a,b --children.budgetShare=F]
                                       (the parent sets the child's fan-out; narrow-only, refused above the ceiling)
  capcomd tree <runId> [--root agt]      subtree with cost/turn rollups and stuck flags
  capcomd tui [runId] [--view live|waterfall|timeline|rollups|events]   the terminal debugger (no runId: the latest run)
  capcomd inspect <runId> <agt> [--tail N]  ·  capcomd logs <runId> <agt> [--tail N] [--follow]  ·  capcomd budget show <runId> [agt]
  capcomd send <runId> <agt> <text> [--from agt] [--skill NAME]…  ·  capcomd token revoke <runId> <jti> [--reason R]
  capcomd skills                         skills send --skill attaches (bundled and ~/.claude/skills): the agent reads each with the message
  capcomd task add <runId> --title T [--data JSON] [--after tsk,…] [--key K]  ·  task list <runId> [--status open|claimed|done]  ·  task show <runId> <tsk>
  capcomd task claim <runId> [tsk] --holder H [--lease-ms N] [--key K]   → {taskId, epoch, leaseUntil}; no id = next free (expired leases are taken over)
  capcomd task renew|release|done <runId> <tsk> --holder H --epoch E [--lease-ms N] [--result JSON] [--key K]   (fenced: a stale epoch is rejected)
  capcomd kv get <runId> <k>  ·  kv put <runId> <k> <json> [--key K]  ·  kv cas <runId> <k> <json> --expect V [--key K]  ·  kv del <runId> <k> [--expect V]  ·  kv list <runId> [--prefix P] [--all]   (values ≤ 64KB; _ keys are run settings, listed with --prefix _)
  capcomd inspect <runId> [--json] [--follow [--since-seq N] [--until TYPE]]   run bundle: status + tree + trace + events
  capcomd events <runId> --follow [--until TYPE] [--timeout-ms N] [--from-start | --since-seq N]   (with --json: one JSON line per event; resume with --since-seq <last seq>)
                                       Named agent profiles (.capcomd/agents.json): provider, auth
                                       (apikey|subscription, exactly one), model, limits, prompts, tools.
                                       add/set flags: --provider --auth --model --effort --max-turns --budget
                                       --timeout-ms --idle-after-ms --stuck-repeats --no-change-after-ms --checkpoint-every-ms --sandbox --egress --system-prompt
                                       --append-system-prompt --allowed-tools --disallowed-tools
                                       --description --default --spec JSON --unset k1,k2
  capcomd auth login claude|codex        Log in with your Claude/ChatGPT plan in a VM; saves a private auth profile
  capcomd auth status [agent] [--quick]  Verify saved logins   |   capcomd auth logout claude|codex
  capcomd secrets sync                   Store local ANTHROPIC/OPENAI keys as boxd host-bound secrets
  capcomd doctor                         Check agents + credentials inside a snapshot VM
  capcomd mcp                            Serve capcomd's primitives over MCP (stdio), for your agent
  capcomd setup [demo|accounts|project|agent|service]   Guided setup (interactive; --yes for defaults)
        [--yes] [--demo|--skip-demo] [--agents claude,codex] [--auth subscription|apikey] [--repo URL]
        [--mode pr|direct] [--target B] [--check CMD] [--budget USD] [--service|--no-service] [--no-plugin] [--no-store]
        [--org NAME]                   (the boxd org for the key setup creates with your boxd CLI login)
        [--no-hermes] [--approvals human|client-confirmed]
                                       (capcomd in Hermes, when it's installed; who approves merges into protected branches)
  capcomd setup check                    What's configured and working (changes nothing)
  capcomd service install|uninstall|status [--port N] [--dry-run]
                                       The engine as a background service (launchd / systemd user unit)
  capcomd upgrade [--to X.Y.Z] [--dry-run]
                                       Replace this capcomd with the latest release (the installed binary;
                                       npm and Homebrew installs say how to upgrade them)
  capcomd ui                             Launch the web UI

Options:
  --json        Machine-readable output (schema "${SCHEMA}"); run streams NDJSON
  --detach      With run: start in the background and print {runId}
  -h, --help    Show this help
  --version     Print the version (also: capcomd version)

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
  // `capcomd tui …`: the terminal debugger takes its own flags (apps/tui/src/run.tsx).
  if (argv[0] === "tui") {
    const { runTui } = await import("../../apps/tui/src/run");
    const O = await import("../primitives/ops");
    return runTui(argv.slice(1), { cli: (await import("../utils/self")).selfArgv(), latestRun: () => O.recentRuns(1)[0]?.runId ?? null });
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        version: { type: "boolean" },
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
        effort: { type: "string" },
        "max-turns": { type: "string" },
        budget: { type: "string" },
        "timeout-ms": { type: "string" },
        "idle-after-ms": { type: "string" },
        "checkpoint-every-ms": { type: "string" },
        "stuck-repeats": { type: "string" },
        "no-change-after-ms": { type: "string" },
        notices: { type: "boolean" },
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
        goal: { type: "string" },
        "harness-socket": { type: "string" },
        scopes: { type: "string" },
        "no-start": { type: "boolean" },
        report: { type: "boolean" },
        continue: { type: "string" },
        "dry-run": { type: "boolean" },
        to: { type: "string" },
        yes: { type: "boolean", short: "y" },
        demo: { type: "boolean" },
        "skip-demo": { type: "boolean" },
        agents: { type: "string" },
        repo: { type: "string" },
        mode: { type: "string" },
        service: { type: "boolean" },
        "no-service": { type: "boolean" },
        "no-skill": { type: "boolean" },
        "no-plugin": { type: "boolean" },
        "no-hermes": { type: "boolean" },
        approvals: { type: "string" },
        "no-store": { type: "boolean" },
        org: { type: "string" },
        relogin: { type: "boolean" },
        deny: { type: "boolean" },
        "target-from": { type: "string" },
        ref: { type: "string" },
        checks: { type: "string" },
        check: { type: "string" },
        "checks-set": { type: "string", multiple: true },
        acceptance: { type: "string" },
        "judge-profile": { type: "string" },
        "review-profile": { type: "string" },
        reviewer: { type: "string" },
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
        strict: { type: "boolean" },
        "since-seq": { type: "string" },
        recipe: { type: "boolean" },
        legacy: { type: "boolean" },
        planner: { type: "string" },
        "planner-provider": { type: "string" },
        "planner-effort": { type: "string" },
        after: { type: "string", multiple: true },
        skill: { type: "string", multiple: true },
        all: { type: "boolean" },
        // ADR-017: fan-out the parent grants a child (narrow-only)
        "children.maxChildren": { type: "string" },
        "children.maxDepth": { type: "string" },
        "children.maxTotalDescendants": { type: "string" },
        "children.allowedChildProfiles": { type: "string" },
        "children.budgetShare": { type: "string" },
        "children.allowSpawn": { type: "string" },
        tail: { type: "string" },
        root: { type: "string" },
        from: { type: "string" },
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
    if (values.version || command === "version") {
      const version = (await import("../utils/self")).VERSION;
      if (json) out({ version }); else console.log(`capcomd ${version}`);
      return EXIT.ok;
    }
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
      case "clients": {
        const C = await import("../api/clients");
        const [, sub, arg] = positionals;
        if (sub === "add" && arg) {
          const scopes = String(values.scopes ?? "read").split(",").map((x) => x.trim()).filter(Boolean) as import("../api/clients").ClientScope[];
          const { client, token } = C.addClient(arg, scopes);
          console.log(JSON.stringify({ id: client.id, name: client.name, scopes: client.scopes, token, note: "shown once; store it in the client" }, null, 2));
          return EXIT.ok;
        }
        if (sub === "list") { console.log(JSON.stringify(C.loadClients().map(({ sha256: _h, ...c }) => c), null, 2)); return EXIT.ok; }
        if (sub === "revoke" && arg) { if (!C.revokeClient(arg)) usage(`no active client ${arg}`); console.log(JSON.stringify({ revoked: arg })); return EXIT.ok; }
        usage("capcomd clients add <name> [--scopes read,steer,approve] | list | revoke <id>");
        return EXIT.usage;
      }
      case "serve":
        await serve({ port: parseInt(values.port as string, 10), ...(values["harness-socket"] ? { harnessSocket: values["harness-socket"] as string } : {}) });
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
          let budget: Record<string, number> = {}; // no budget: the run is unlimited
          try { if (values.budget !== undefined) budget = parseBudget(values.budget); } catch (e) { usage(`--budget: ${(e as Error).message} (e.g. 5 or usd=5,turns=200,wallSeconds=3600)`); }
          const P = await import("../primitives/ops");
          // Flags win; else the project's `capcomd setup` defaults (.capcomd/config.json "run").
          const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../config/store")).runDefaults();
          const checks = values["checks-set"] ? P.parseCheckSet(values["checks-set"] as string[]) : (d.checks ?? {});
          const reviewer = (values.reviewer as string | undefined) ?? d.reviewer;
          const target = (values.target as string | undefined) ?? d.target;
          const r = await P.runNew({ budget, label: values.label as string | undefined, ...(values.goal ? { goal: values.goal as string } : {}), key: values.key as string | undefined, runId: values["run-id"] as string | undefined, checks, ...(reviewer ? { reviewer } : {}), ...(target ? { target } : {}), ...(values["target-from"] ? { targetFrom: values["target-from"] as string } : {}) });
          if (json) out(r); else console.log(r.runId);
          return EXIT.ok;
        }
        const rawGoal = positionals[1];
        if (!rawGoal) usage("goal required: capcomd run <goal>");
        // A planner agent plans real work: --planner P, or on real VMs the profile named "planner" (capcomd setup writes
        // it). The built-in recipe's planner is a placeholder model, so real VMs need --recipe/--legacy to use it.
        const PA = await import("../recipes/planner-agent");
        // --sandbox NAME: where this run's agents and checks run (recorded with the run), instead of CAPCOMD_SANDBOX.
        // This process (the planner's choice, preflight, the run's driver) sees it as its own CAPCOMD_SANDBOX.
        let runSandbox: string | undefined;
        if (values.sandbox !== undefined) {
          const RS = await import("../providers/run-sandbox");
          const n = String(values.sandbox).toLowerCase();
          if (!RS.isProviderName(n)) usage(`--sandbox names where the run's agents run: docker or boxd (got ${values.sandbox})`);
          if (values.legacy || (!values.recipe && !values.planner && !values["planner-provider"] && !values["planner-effort"] && (process.env.CAPCOMD_RUN_PATH ?? DEFAULT_RUN_PATH) === "legacy")) usage("--sandbox needs a planner or recipe run (not --legacy)");
          process.env.CAPCOMD_SANDBOX = n;
          delete process.env.RELAY_SANDBOX;
          runSandbox = n;
        }
        // --planner-provider claude|codex: who drives the run, i.e. the planner agent's provider (src/agents/run-driver.ts).
        const driver = values["planner-provider"] as string | undefined;
        if (driver !== undefined) {
          if (values.recipe || values.legacy) usage("--planner-provider runs a planner agent; don't combine it with --recipe/--legacy");
          if (driver !== "claude" && driver !== "codex") usage(`--planner-provider must be claude or codex (got ${driver})`);
        }
        // --planner-effort LEVEL: the planner's reasoning effort (one of its provider's levels; checked with the profile).
        const effort = values["planner-effort"] as string | undefined;
        if (effort !== undefined && (values.recipe || values.legacy)) usage("--planner-effort sets a planner agent's effort; don't combine it with --recipe/--legacy");
        const realVms = (await import("../providers/registry")).realSandbox();
        let planner: string | null = null;
        if (values.planner !== undefined) {
          if (values.recipe || values.legacy) usage("--planner runs a planner agent; don't combine it with --recipe/--legacy");
          planner = PA.plannerProfile(values.planner as string);
          if (!planner) throw PA.noPlannerError(values.planner as string);
        } else if (driver !== undefined || effort !== undefined || (!values.recipe && !values.legacy && !process.env.CAPCOMD_RUN_PATH && realVms)) {
          planner = PA.plannerProfile();
          if (!planner) throw PA.noPlannerError();
        }
        // The planner agent's ref: its profile, with the provider swapped when --planner-provider names another.
        let plannerRef = planner;
        if (planner && (driver || effort)) {
          const RD = await import("../agents/run-driver");
          const p = (driver as "claude" | "codex" | undefined) ?? RD.profileProvider(planner);
          const d = RD.plannerDriver(p, planner, process.env, effort);
          if (!d.ok && d.code === "effort") usage(d.reason);
          if (!d.ok) throw new RelayError("config", `${p} can't drive this run: ${d.reason}`, `Log in with \`capcomd auth login ${p}\` (or set its API key), or leave out --planner-provider to use the planner profile's own provider.`);
          plannerRef = d.ref;
        }
        if (planner && (values.profile || values.agent || (values.set as string[] | undefined)?.length || values.overrides)) usage("--profile/--set pick the worker of the built-in recipe; a planner agent picks its own workers (from its profile's children.allowedChildProfiles)");
        // The checks the planner's spawn makes (its profile, the env snapshot its CLI needs on this run's sandbox, egress),
        // made before the run is created or detached: a run whose planner can't start is refused with the reason here,
        // instead of starting and then sitting with no agent.
        if (plannerRef) (await import("../primitives/ops")).spawnChecks(plannerRef);
        // Humans only (scripts and --json callers read stdout; stderr isn't a terminal for them).
        if (!planner && process.stderr.isTTY) console.error(`capcomd run ${realVms ? "--recipe" : "without a planner agent"} plans with a placeholder model (the same generic tasks for any goal) and judges nothing. For real work: --planner <profile> (capcomd setup writes one named "planner"), or the primitives (run new, spawn, verify, merge).`);
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
          const dir = join((await import("../utils/home")).stateDir(), "runs");
          mkdirSync(dir, { recursive: true });
          const log = join(dir, `${runId}.ndjson`);
          const fd = openSync(log, "a");
          const [cmd, ...args] = (await import("../utils/self")).selfArgv("run", "--json", "--run-id", runId, ...(targetBranch ? ["--target-branch", targetBranch] : []), ...(planner ? ["--planner", planner] : values.recipe ? ["--recipe"] : values.legacy ? ["--legacy"] : []), ...(driver ? ["--planner-provider", driver] : []), ...(effort ? ["--planner-effort", effort] : []), ...(runSandbox ? ["--sandbox", runSandbox] : []), "--", goal);
          const child = spawn(cmd!, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
          child.unref();
          if (json) out({ runId, detached: true, log, pid: child.pid });
          else console.log(`Started run ${runId} in the background (log: ${log})`);
          return EXIT.ok;
        }

        initDependencies();
        // ADR-016 step 4: the planner→worker→judge flow as a recipe over the primitives, or the
        // legacy hard-wired loop. --recipe/--legacy, else CAPCOMD_RUN_PATH, else the default.
        if (values.recipe && values.legacy) usage("pass at most one of --recipe / --legacy");
        const runPath = values.recipe ? "recipe" : values.legacy ? "legacy" : (process.env.CAPCOMD_RUN_PATH ?? DEFAULT_RUN_PATH);
        if (runPath !== "recipe" && runPath !== "legacy") usage(`CAPCOMD_RUN_PATH must be recipe or legacy, got ${runPath}`);
        let lineSeq = 0;
        const emit = (type: string, data: Record<string, unknown>, human: string) => {
          const now = Date.now();
          if (json) console.log(JSON.stringify({ schema: SCHEMA, type, runId, seq: ++lineSeq, ts: new Date(now).toISOString(), epochMs: now, agentId: (data.agentId as string | undefined) ?? null, ...data }));
          else console.log(human);
        };
        const result = planner
          ? await PA.runWithPlanner({ goal, runId, targetBranch, emit, profile: plannerRef!, ...(driver ? { driver } : {}), ...(runSandbox ? { sandbox: runSandbox } : {}) })
          : runPath === "recipe"
          ? await (await import("../recipes/hierarchical")).runHierarchicalRecipe({ goal, runId, targetBranch, emit, ...(runSandbox ? { sandbox: runSandbox } : {}) })
          : await executeRun({ goal, runId, targetBranch, emit });
        if (json) { const now = Date.now(); console.log(JSON.stringify({ schema: SCHEMA, type: "run.result", runId, seq: ++lineSeq, ts: new Date(now).toISOString(), epochMs: now, agentId: null, ok: result.ok, state: result.state })); }
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
          operator: !!values.operator, start: !values["no-start"], ...(values.check !== undefined ? { check: values.check as string } : {}), ...(values.report ? { report: true } : {}),
          ...(values.continue ? { continueFrom: values.continue as string } : {}),
          grant: Object.fromEntries(Object.entries(values).filter(([k, v]) => k.startsWith("children.") && v !== undefined).map(([k, v]) => [k.slice(9), v])),
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
        const r: any = await P.awaitAgents(runId, ids, { timeoutMs, any: command === "wait-any", notices: !!values.notices });
        if (json) out(r);
        else for (const a of r.agents) console.log(`${a.agentId}: ${a.status}${a.notice ? ` ${String(a.notice.kind).toUpperCase()}: ${a.notice.detail}` : ""}${a.result?.commit ? ` ${String(a.result.commit).slice(0, 12)}` : ""}${a.result?.error ? ` (${a.result.error})` : ""}`);
        // A notice (ADR-019 §2) ends the wait while the agent still runs: not done, like a timeout.
        if (r.timeout || r.notices) return EXIT.run_failed;
        const relevant = command === "wait-any" ? [r.first] : r.agents;
        return relevant.every((a: any) => a.status === "done") ? EXIT.ok : EXIT.run_failed;
      }

      case "verify": {
        const runId = positionals[1] ?? usage("runId required: capcomd verify <runId> --ref <agt|branch> [--check NAME | --checks CMD] [--acceptance JSON|file] [--judge-profile P]");
        const ref = (values.ref as string | undefined) ?? positionals[2] ?? usage("--ref required (an agent id or a branch)");
        let acceptance: unknown;
        if (values.acceptance) {
          const raw = String(values.acceptance);
          try { acceptance = raw.trim().startsWith("{") || raw.trim().startsWith("[") ? JSON.parse(raw) : existsSync(raw) ? JSON.parse(readFileSync(raw, "utf8")) : raw; } catch (e) { usage(`bad --acceptance: ${(e as Error).message}`); }
        }
        const r: any = await (await import("../primitives/ops")).verifyRef({
          runId, ref, checks: values.checks as string | undefined, check: values.check as string | undefined, acceptance, reviewProfile: (values["review-profile"] ?? values["judge-profile"]) as string | undefined,
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

      case "inspect": {
        const runId = positionals[1] ?? usage("capcomd inspect <runId> [agt] [--json] [--follow]");
        if (!positionals[2]) {
          // TUI contract: one bundle (status + tree + trace + events); --follow then streams event lines.
          const bundle = async () => {
            const P = await import("../primitives/ops");
            const [status, tree, events] = await Promise.all([
              getStatus(runId), P.treeOf(runId).catch(() => ({ runId, root: null, tree: [], totals: null })), listEvents(runId),
            ]);
            const trace = loadTrace(runId) ?? (await runTraceAt(runId));
            const now = Date.now();
            return { type: "inspect.snapshot", runId, ts: new Date(now).toISOString(), epochMs: now, seq: events.length, status, tree: tree.tree, totals: tree.totals, trace, events };
          };
          const snap = await bundle();
          if (!values.follow) {
            if (json) out(snap);
            else {
              console.log(`Run ${runId}  ${snap.status.state}${snap.status.scope ? ` (agents ${snap.status.scope.state})` : ""}  started ${snap.status.startedAt ?? "-"}`);
              console.log(`Goal: ${snap.status.goal}`);
              if (snap.status.pendingApprovals.length) console.log(`Pending approvals: ${snap.status.pendingApprovals.map((p) => p.taskId).join(", ")}`);
              console.log(`Agents: ${JSON.stringify(snap.totals)}  events ${snap.events.length}  spans ${snap.trace?.spanCount ?? 0}`);
            }
            return EXIT.ok;
          }
          const emit = (o: Record<string, unknown>) => json ? out(o) : console.log(JSON.stringify(o));
          const sinceSeq = values["since-seq"] !== undefined ? Number(values["since-seq"]) : snap.seq;
          emit({ ...snap, events: snap.events.filter((e) => e.seq > (values["since-seq"] !== undefined ? sinceSeq : -1)) });
          const S = await import("../primitives/state");
          const P = await import("../primitives/ops");
          // Spans are appended as they end, so a TUI attached early would never see them: push the trace
          // again whenever its file grows (checked every CAPCOMD_INSPECT_TRACE_MS, default 2s).
          const traceFile = async () => { const { tracePath } = await import("../utils/tracing-simple"); const own = tracePath(runId); if (existsSync(own)) return own; const d = await P.runTraceDir(runId); return d ? tracePath(runId, d) : own; };
          let traceSize = await traceFile().then((f) => (existsSync(f) ? statSync(f).size : 0)).catch(() => -1); // the snapshot already has this much
          const tracePoll = setInterval(async () => {
            try {
              const f = await traceFile();
              const size = existsSync(f) ? statSync(f).size : 0;
              if (size === traceSize) return;
              traceSize = size;
              const t = loadTrace(runId, dirname(f));
              if (t) emit({ type: "inspect.trace", runId, ts: new Date().toISOString(), trace: t });
            } catch { /* next tick */ }
          }, Number(process.env.CAPCOMD_INSPECT_TRACE_MS ?? 2000));
          const r = await S.followEvents(runId, {
            sinceSeq, until: values.until as string | undefined,
            timeoutMs: values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : undefined,
            emit: (ev) => {
              emit({ type: "event", runId, seq: ev.seq, ts: ev.ts, epochMs: ev.epochMs, agentId: ev.agentId, event: ev });
              // Agent lifecycle changes the tree: push a fresh one so a TUI never has to re-poll.
              if (/^AGENT_/.test(ev.type)) void P.treeOf(runId).then((t) => emit({ type: "inspect.tree", runId, seq: ev.seq, ts: new Date().toISOString(), tree: t.tree, totals: t.totals })).catch(() => {});
            },
          });
          clearInterval(tracePoll);
          emit({ type: "inspect.end", runId, ts: new Date().toISOString(), end: r });
          return EXIT.ok;
        }
        const id = positionals[2];
        const r: any = await (await import("../primitives/ops")).inspectAgent(runId, id, { logTail: values.tail ? Number(values.tail) : 50 });
        if (json) out(r);
        else {
          console.log(`${r.agentId} [${r.profile ?? "-"}] ${r.status}${r.notice ? ` ${String(r.notice.kind).toUpperCase()}: ${r.notice.detail}` : ""}  parent ${r.parent ?? "(operator)"}  depth ${r.depth}`);
          console.log(`  budget ${JSON.stringify(r.budget)} spent ${JSON.stringify(r.spent)}  subtree ${JSON.stringify(r.rollup)}`);
          console.log(`  limits ${JSON.stringify(r.limits)}`);
          console.log(`  vm ${JSON.stringify(r.vm)}  driver ${r.driver ?? "-"}  heartbeat ${r.heartbeatAt ? new Date(r.heartbeatAt).toISOString() : "-"} ${r.heartbeatNote ?? ""}`);
          if (r.children.length) console.log(`  children: ${r.children.map((c: any) => `${c.agentId}(${c.status})`).join(", ")}`);
          if (r.awaits.length) console.log(`  awaits: ${r.awaits.map((w: any) => `${w.waiter}→${w.target}`).join(", ")}`);
          if (r.result) console.log(`  result ${JSON.stringify(r.result).slice(0, 800)}`);
          for (const l of r.logs) console.log(`  | ${l.line}`);
        }
        return EXIT.ok;
      }

      case "logs": {
        const runId = positionals[1] ?? usage("capcomd logs <runId> <agt> [--tail N] [--follow]");
        const id = positionals[2] ?? usage("capcomd logs <runId> <agt> [--tail N] [--follow]");
        const O = await import("../primitives/ops");
        const show = (l: { at: number; stream: string; line: string }) => (json ? console.log(JSON.stringify(l)) : console.log(`${new Date(l.at).toISOString()} ${l.stream.padEnd(6)} ${l.line}`));
        const r = await O.agentLogs(runId, id, values.tail ? Number(values.tail) : 200);
        if (!values.follow) { if (json) out(r); else r.lines.forEach(show); return EXIT.ok; }
        // --follow: new lines as they come (one JSON object per line with --json), until the agent is finished.
        r.lines.forEach(show);
        let after = r.lines.at(-1)?.seq ?? 0;
        for (let status = r.status; ; ) {
          const finished = (await import("../primitives/policy")).TERMINAL_AGENT.has(status as any);
          const more = await O.agentLogs(runId, id, 500, after);
          more.lines.forEach(show);
          after = more.lines.at(-1)?.seq ?? after;
          if (finished && !more.lines.length) return EXIT.ok;
          status = more.status;
          if (!more.lines.length) await new Promise((res) => setTimeout(res, 1000));
        }
      }

      case "budget": {
        const runId = positionals[2] ?? positionals[1] ?? usage("capcomd budget show <runId> [agt]");
        const rid = positionals[1] === "show" ? positionals[2] : positionals[1];
        const agentId = positionals[1] === "show" ? positionals[3] : positionals[2];
        const r = await (await import("../primitives/ops")).budgetShow(rid ?? runId, agentId);
        if (json) out(r); else console.log(JSON.stringify(r, null, 2));
        return EXIT.ok;
      }

      case "send": {
        const runId = positionals[1] ?? usage("capcomd send <runId> <agt> <text> [--from agt|operator]");
        const to = positionals[2] ?? usage("capcomd send <runId> <agt> <text>");
        const body = positionals.slice(3).join(" ") || usage("message text required");
        // --skill NAME (repeatable): the agent gets that skill's SKILL.md with the message (`capcomd skills` lists them).
        const names = (values.skill as string[] | undefined) ?? [];
        const sk = names.length ? await (await import("../agents/skills")).resolveSkills(names, { listedBy: "`capcomd skills`" }) : { skills: [] };
        if ("error" in sk) usage(sk.error);
        const { note, ...r } = await (await import("../primitives/ops")).sendToAgent(runId, { to, from: (values.from as string | undefined) ?? "operator", body, ...(values.key ? { key: String(values.key) } : {}), ...(sk.skills.length ? { skills: sk.skills } : {}) });
        if (json) out({ runId, to, ...r, ...(note ? { note } : {}) }); else console.log(`sent #${r.seq} to ${to}${note ? ` (${note})` : ""}`);
        return EXIT.ok;
      }

      case "token": {
        // capcomd token revoke <runId> <jti> [--reason R]: kills an in-VM token now (the pump also revokes on exit).
        if (positionals[1] !== "revoke") usage("capcomd token revoke <runId> <jti> [--reason R]");
        const runId = positionals[2] ?? usage("capcomd token revoke <runId> <jti>");
        const jti = positionals[3] ?? usage("capcomd token revoke <runId> <jti>");
        const { client: cl, assertEngine: ae } = await import("../core/relay");
        await ae();
        const r = await cl().scope.getOrCreate([runId]).revokeToken({ jti, reason: values.reason as string | undefined });
        if (json) out({ runId, jti, ...r }); else console.log(`revoked ${jti}`);
        return EXIT.ok;
      }

      case "tree": {
        const runId = positionals[1] ?? usage("runId required: capcomd tree <runId> [--root agt]");
        const O = await import("../primitives/ops");
        const r: any = { ...(await O.listScope(runId)), ...(await O.treeOf(runId, values.root as string | undefined)) };
        if (json) out(r);
        else if (process.env.CAPCOMD_TREE_FLAT !== "1") {
          const b = (x: Record<string, number>) => Object.entries(x).map(([k, v]) => `${k}=${v}`).join(",") || "-";
          console.log(`${runId}  budget ${b(r.budget)} (unallocated ${b(r.unallocated)}, spent ${b(r.spent)})  totals: ${r.totals.agents} agents $${r.totals.usd}${(await import("../subagents/results")).notional(r.totals.notionalUsd)} ${r.totals.turns} turns ${r.totals.wallSeconds}s`);
          console.log((await import("../subagents/results")).textTree(r.tree, "  "));
        }
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
        // A recipe run (planner flow over the primitives) keeps the run-level cancel contract
        // ({runId, state, changed}); its scope agents are cancelled alongside.
        const c = await (await import("../primitives/ops")).cancelAny(runId, positionals[2], values.reason as string | undefined, "operator");
        if (c.kind === "agents") {
          const r = c.agents;
          if (json) out(r);
          else console.log(r.cancelled.length ? `✓ cancelled ${r.cancelled.join(", ")}` : r.runEnded ? `✓ Run ${runId} cancelled` : `nothing to cancel (${r.affected.map((a: { agentId: string; status: string }) => `${a.agentId}=${a.status}`).join(", ") || "no agents"})`);
          return EXIT.ok;
        }
        const r = c.run;
        if (json) out(r);
        else console.log(r.changed ? `✓ Run ${runId} cancelled` : `Run ${runId} is ${r.state}; nothing to cancel`);
        return EXIT.ok;
      }

      case "pause": {
        const runId = positionals[1] ?? usage("runId required: capcomd pause <runId> [agentId]");
        const r = await (await import("../primitives/ops")).pauseAgents(runId, positionals[2]);
        if (json) out(r);
        else console.log(r.paused.length || r.pausing.length
          ? [r.paused.length ? `✓ paused ${r.paused.join(", ")}` : "", r.pausing.length ? `pausing ${r.pausing.join(", ")} (each stops at its next check, keeping its work)` : ""].filter(Boolean).join("; ")
          : "no pending or running agents to pause");
        return EXIT.ok;
      }

      case "grant": {
        // ADR-019 §4: more budget for a live agent (from its parent's, or the run's), or with no agent, the run's.
        const runId = positionals[1] ?? usage("capcomd grant <runId> [agt] --budget usd=…,turns=…,wallSeconds=… [--key K]");
        let add: Record<string, number> = {};
        try { add = (await import("../primitives/policy")).parseBudget(values.budget); } catch (e) { usage(`--budget: ${(e as Error).message}`); }
        if (!Object.keys(add).length) usage("capcomd grant <runId> [agt] --budget usd=…,turns=…,wallSeconds=…");
        const r: any = await (await import("../primitives/ops")).grantBudget(runId, { ...(positionals[2] ? { agentId: positionals[2] } : {}), add, by: "operator", ...(values.key ? { key: String(values.key) } : {}) });
        const b = (x: Record<string, number> = {}) => Object.entries(x).map(([k, v]) => `${k}=${v}`).join(",") || "-";
        if (json) out(r);
        else console.log(`✓ ${r.agentId ?? runId} budget ${b(r.budget)}${r.replayed ? " (already granted)" : ""}; ${r.agentId ? r.from : "the run"} has ${b(r.left)} left${r.agentId ? "" : " to give"}`);
        return EXIT.ok;
      }

      case "skills": {
        // The skills `capcomd send --skill` (and the harness API's `skills`) can attach: bundled ones and ~/.claude/skills.
        const list = await (await import("../agents/skills")).listSkills();
        if (json) out({ skills: list });
        else console.log(list.length ? list.map((s) => `${s.name}  (${s.source})${s.description ? `  ${s.description}` : ""}`).join("\n") : "no skills");
        return EXIT.ok;
      }

      case "resume": {
        const runId = positionals[1] ?? usage("runId required: capcomd resume <runId> [agentId]");
        const r = await (await import("../primitives/ops")).resumeAgents(runId, positionals[2]);
        if (json) out(r);
        else console.log(r.resumed.length ? `✓ resumed ${r.resumed.join(", ")}` : "no paused agents to resume");
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
        let sinceSeq: number | undefined;
        if (values["since-seq"] !== undefined) { sinceSeq = Number(values["since-seq"]); if (!Number.isInteger(sinceSeq) || sinceSeq < 0) usage("--since-seq must be an integer >= 0 (the seq of the last line you saw)"); }
        if (values.follow) {
          const S = await import("../primitives/state");
          const r = await S.followEvents(runId, {
            until: values.until as string | undefined, fromStart: !!values["from-start"], sinceSeq,
            timeoutMs: values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : undefined,
            emit: (ev) => json ? out({ runId, seq: ev.seq, ts: ev.ts, epochMs: ev.epochMs, agentId: ev.agentId, type: ev.type, event: ev }) : console.log(`[${ev.entity.padEnd(20)}] ${new Date(ev.at).toISOString()} ${JSON.stringify(ev.event)}`),
          });
          if (json) out({ runId, end: r, ts: new Date().toISOString() });
          return EXIT.ok;
        }
        const limit = values.limit ? Number.parseInt(values.limit as string, 10) : 1000;
        if (!Number.isFinite(limit) || limit < 1) usage("--limit must be a positive integer");
        const all = (await listEvents(runId)).filter((e) => sinceSeq === undefined || e.seq > sinceSeq);
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
        const tree = loadTrace(runId) ?? (await runTraceAt(runId));
        if (!tree) throw new RelayError("not_found", `No trace found for run ${runId}`, "Traces are written to .traces/<runId>.ndjson while a run executes; start one with `capcomd run`.");
        if (json) out({ trace: tree });
        else console.log(renderTrace(tree));
        return EXIT.ok;
      }

      case "setup": {
        const S = await import("./commands/setup");
        const part = positionals[1];
        if (part === "check") {
          const steps = await S.checkSetup();
          if (json) out({ steps, ok: steps.every((s) => s.ok) }); else console.log(`capcomd setup check\n${S.formatSteps(steps)}`);
          return steps.every((s) => s.ok) ? EXIT.ok : EXIT.run_failed;
        }
        if (part && !["all", "demo", "accounts", "project", "agent", "service"].includes(part)) usage("usage: capcomd setup [demo|accounts|project|agent|service|check] [--yes] [flags]");
        const v = { ...values, ...(values.agents === undefined ? {} : { agents: values.agents }) } as Record<string, unknown>;
        const steps = await S.setup(part, v, json ? () => {} : (l) => console.log(l));
        const ok = steps.every((s) => s.ok);
        if (json) out({ steps, ok });
        else console.log(`\n${S.formatSteps(steps)}\n${ok ? "\nReady. Next: `capcomd setup check` any time; README Quickstart step 4 to run agents." : "\nSome steps need attention (see → above). Re-run `capcomd setup` (finished steps are skipped or kept)."}`);
        return ok ? EXIT.ok : EXIT.run_failed;
      }

      case "upgrade": {
        const r: any = await (await import("./commands/upgrade")).upgrade({ to: values.to as string | undefined, dryRun: !!values["dry-run"] });
        if (json) out(r);
        else if (r.how) console.log(`capcomd ${r.current} was installed with ${r.how.split(" ")[0]}; upgrade it with: ${r.how}`);
        else if (r.upgraded) console.log(`✓ capcomd ${r.current} → ${r.latest} (${r.path})\n  ${r.next}`);
        else if (r.dryRun) console.log(`capcomd ${r.latest} is available (this is ${r.current}); run \`capcomd upgrade\` to install it`);
        else console.log(`capcomd ${r.current} is the latest`);
        return EXIT.ok;
      }

      case "service": {
        const S = await import("./commands/service");
        const sub = positionals[1] ?? "status";
        const port = parseInt(values.port as string, 10);
        if (sub === "install") {
          const r: any = await S.serviceInstall({ port, dryRun: !!values["dry-run"] });
          if (json) out(r);
          else if (r.dryRun) console.log(`would write ${r.path}:\n\n${r.body}`);
          else console.log(`✓ engine service installed (${r.path}); ${r.running ? `running on :${r.port}` : `not answering on :${r.port} yet; see ${r.log}`}`);
          return r.dryRun || r.running ? EXIT.ok : EXIT.run_failed;
        }
        if (sub === "uninstall") { const r = S.serviceUninstall(); if (json) out(r); else console.log(r.uninstalled ? `✓ removed ${r.path}` : "no engine service was installed"); return EXIT.ok; }
        if (sub === "status") {
          const r = await S.serviceStatus({ port });
          if (json) out(r); else console.log(`service: ${r.installed ? (r.loaded ? "installed, loaded" : "installed, not loaded") : "not installed"}; engine on :${r.port}: ${r.running ? "running" : "not running"}  (log: ${r.log})`);
          return EXIT.ok;
        }
        usage("usage: capcomd service install|uninstall|status [--port N] [--dry-run]");
        return EXIT.usage;
      }

      case "approve": {
        const runId = positionals[1] ?? usage("usage: capcomd approve <runId> <taskId|mrgId> [--deny] [--reason R]");
        const taskId = positionals[2] ?? usage("usage: capcomd approve <runId> <taskId|mrgId> [--deny] [--reason R]");
        // An agent's merge into a protected target (mrg-…): approve runs it, --deny fails it.
        if (taskId.startsWith("mrg-")) {
          const P = await import("../primitives/ops");
          const m: any = await P.decideMerge(runId, taskId, { approve: !values.deny, by: (values.by as string | undefined) ?? "cli", ...(values.reason ? { reason: String(values.reason) } : {}) });
          if (json) out(m); else console.log(`${taskId}: ${m.state}${m.result?.sha ? ` (${String(m.result.sha).slice(0, 12)})` : ""}${m.result?.reason ? ` ${m.result.reason}` : ""}`);
          return m.state === "merged" || (values.deny && m.state === "failed") ? EXIT.ok : EXIT.run_failed;
        }
        if (values.deny) usage("--deny applies to an agent's parked merge (mrg-…)");
        // Both run paths park protected merges on the task-board ledger (public contract).
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

/** A run's trace from where the run wrote it (its CAPCOMD_TRACE_DIR at `run new`), when this shell's dir has none. */
async function runTraceAt(runId: string) {
  const dir = await (await import("../primitives/ops")).runTraceDir(runId).catch(() => undefined);
  return dir ? loadTrace(runId, dir) : null;
}

const code = await main(process.argv.slice(2));
if (code !== 0 || !["serve", "ui", "mcp"].includes(process.argv[2] ?? "")) process.exit(code);
