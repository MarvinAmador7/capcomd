// front-primitives's commands (src/plugins/front/groups.ts): the ADR-016 primitives (spawn, wait, verify, check, merge,
// the board and kv). Moved as they were from src/cli/index.ts's `switch`, one function per command (§17.2 step 8).
import { existsSync, readFileSync } from "fs";
import { EXIT } from "../../core/errors";
import { assertEngine } from "../../core/relay";
import { type Cmd, type KernelCommand, usage, out, jsonish, deepMerge } from "./common";

/** `capcomd spawn` */
async function spawnCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd spawn <runId> --task TEXT [--profile P] [--parent agt] [--key K]");
  const task = (values.task as string | undefined) ?? positionals[2] ?? usage("--task required");
  const profile = (values.profile ?? values.agent) as string | undefined;
  const sets = (values.set as string[] | undefined) ?? [];
  let set: Record<string, unknown> = {};
  try {
    if (values.overrides) set = JSON.parse(values.overrides as string);
    set = deepMerge(set, (await import("../../profiles")).parseSetPairs(sets));
  } catch (e) { usage(`bad override: ${(e as Error).message}`); }
  if ((Object.keys(set).length) && !profile) usage("--set/--overrides need --profile NAME");
  let contract: Record<string, unknown> | undefined;
  if (values.contract) {
    const raw = String(values.contract);
    try { contract = JSON.parse(raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8")); } catch (e) { usage(`bad --contract (JSON or a JSON file): ${(e as Error).message}`); }
  }
  let budget: Record<string, number> | undefined;
  try { if (values.budget !== undefined) budget = (await import("../../primitives/policy")).parseBudget(values.budget); } catch (e) { usage(`--budget: ${(e as Error).message}`); }
  const P = await import("../../primitives/ops");
  const r = await P.spawnAgent({
    runId, task, ...(profile ? { profile } : {}), ...(Object.keys(set).length || values.operator ? { overrides: { set, operator: !!values.operator } } : {}),
    parent: values.parent as string | undefined, key: values.key as string | undefined, contract, budget,
    operator: !!values.operator, start: !values["no-start"], ...(values.check !== undefined ? { check: values.check as string } : {}), ...(values.report ? { report: true } : {}),
    ...(values.continue ? { continueFrom: values.continue as string } : {}),
    ...(values.title !== undefined ? { title: values.title as string } : {}),
    grant: Object.fromEntries(Object.entries(values).filter(([k, v]) => k.startsWith("children.") && v !== undefined).map(([k, v]) => [k.slice(9), v])),
  });
  if (json) out(r); else console.log(r.agentId);
  return EXIT.ok;
}

/** `capcomd await | wait-any` */
async function awaitCommand({ command, positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage(`runId required: capcomd ${command} <runId> <agentId…>`);
  const ids = positionals.slice(2);
  if (!ids.length) usage(`agent ids required: capcomd ${command} <runId> <agentId…>`);
  const timeoutMs = values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined;
  const P = await import("../../primitives/ops");
  const r: any = await P.awaitAgents(runId, ids, { timeoutMs, any: command === "wait-any", notices: !!values.notices });
  if (json) out(r);
  else for (const a of r.agents) console.log(`${a.agentId}: ${a.status}${a.notice ? ` ${String(a.notice.kind).toUpperCase()}: ${a.notice.detail}` : ""}${a.result?.commit ? ` ${String(a.result.commit).slice(0, 12)}` : ""}${a.result?.error ? ` (${a.result.error})` : ""}`);
  // A notice (ADR-019 §2) ends the wait while the agent still runs: not done, like a timeout.
  if (r.timeout || r.notices) return EXIT.run_failed;
  const relevant = command === "wait-any" ? [r.first] : r.agents;
  return relevant.every((a: any) => a.status === "done") ? EXIT.ok : EXIT.run_failed;
}

/** `capcomd verify` */
async function verifyCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd verify <runId> --ref <agt|branch> [--check NAME | --checks CMD] [--acceptance JSON|file] [--judge-profile P]");
  const ref = (values.ref as string | undefined) ?? positionals[2] ?? usage("--ref required (an agent id or a branch)");
  let acceptance: unknown;
  if (values.acceptance) {
    const raw = String(values.acceptance);
    try { acceptance = raw.trim().startsWith("{") || raw.trim().startsWith("[") ? JSON.parse(raw) : existsSync(raw) ? JSON.parse(readFileSync(raw, "utf8")) : raw; } catch (e) { usage(`bad --acceptance: ${(e as Error).message}`); }
  }
  const r: any = await (await import("../../primitives/ops")).verifyRef({
    runId, ref, checks: values.checks as string | undefined, check: values.check as string | undefined, acceptance, reviewProfile: (values["review-profile"] ?? values["judge-profile"]) as string | undefined,
    target: values.target as string | undefined, key: values.key as string | undefined,
  });
  if (json) out(r);
  else console.log(`${r.id}: ${r.state}${r.result?.commit ? ` (${String(r.result.commit).slice(0, 12)})` : ""}${r.result?.checks?.reason ? ` ${r.result.checks.reason}` : ""}${r.result?.combined?.text ? `\n  ${r.result.combined.text}` : ""}`);
  return r.state === "passed" ? EXIT.ok : EXIT.run_failed;
}

/** `capcomd check` */
async function checkCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd check <runId> [<agt|branch>] [--check NAME | --checks CMD] [--key K]");
  const ref = (values.ref as string | undefined) ?? positionals[2];
  const r: any = await (await import("../../primitives/ops")).checkRef({
    runId, ...(ref ? { ref } : {}), ...(values.id ? { id: values.id as string } : {}), checks: values.checks as string | undefined, check: values.check as string | undefined, key: values.key as string | undefined,
  });
  if (json) out(r);
  else {
    const output = typeof r.result?.checks?.output === "string" ? r.result.checks.output.trimEnd() : "";
    if (output) console.log(output);
    console.log(`${r.id}: ${r.state}${r.result?.text ? `\n  ${r.result.text}` : ""}`);
  }
  return r.state === "passed" ? EXIT.ok : EXIT.run_failed;
}

/** `capcomd merge` */
async function mergeCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd merge <runId> --ref <agt|branch> --require <vfyId> [--target T]");
  const ref = (values.ref as string | undefined) ?? positionals[2] ?? usage("--ref required (an agent id or a branch)");
  const r: any = await (await import("../../primitives/ops")).mergeRef({
    runId, ref, require: values.require as string | undefined, target: values.target as string | undefined,
    operator: !!values.operator, key: values.key as string | undefined,
  });
  if (json) out(r);
  else console.log(`${r.id}: ${r.state}${r.result?.sha ? ` ${String(r.result.sha).slice(0, 12)}` : ""}${r.result?.reason ? ` ${r.result.reason}` : ""}${r.result?.combined?.text ? `\n  ${r.result.combined.text}` : ""}`);
  if (!json && r.state === "awaiting_approval" && r.heldBy) console.log((await import("../status-text")).heldMergeText(runId, r.id, r).join("\n"));
  // The merged agent's checkpoint refs are deleted after the merge's record: finish that before this process ends.
  await (await import("../../primitives/ops")).settleCleanups();
  return r.state === "merged" ? EXIT.ok : EXIT.run_failed;
}

/** `capcomd budget` */
async function budgetCommand({ positionals, json }: Cmd): Promise<number> {
  const runId = positionals[2] ?? positionals[1] ?? usage("capcomd budget show <runId> [agt]");
  const rid = positionals[1] === "show" ? positionals[2] : positionals[1];
  const agentId = positionals[1] === "show" ? positionals[3] : positionals[2];
  const r = await (await import("../../primitives/ops")).budgetShow(rid ?? runId, agentId);
  if (json) out(r); else console.log(JSON.stringify(r, null, 2));
  return EXIT.ok;
}

/** `capcomd send` */
async function sendCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("capcomd send <runId> <agt> <text> [--from agt|operator]");
  const to = positionals[2] ?? usage("capcomd send <runId> <agt> <text>");
  const body = positionals.slice(3).join(" ") || usage("message text required");
  // --skill NAME (repeatable): the agent gets that skill's SKILL.md with the message (`capcomd skills` lists them).
  const names = (values.skill as string[] | undefined) ?? [];
  const sk = names.length ? await (await import("../../agents/skills")).resolveSkills(names, { listedBy: "`capcomd skills`" }) : { skills: [] };
  if ("error" in sk) usage(sk.error);
  const { note, ...r } = await (await import("../../primitives/ops")).sendToAgent(runId, { to, from: (values.from as string | undefined) ?? "operator", body, ...(values.key ? { key: String(values.key) } : {}), ...(sk.skills.length ? { skills: sk.skills } : {}) });
  if (json) out({ runId, to, ...r, ...(note ? { note } : {}) }); else console.log(`sent #${r.seq} to ${to}${note ? ` (${note})` : ""}`);
  return EXIT.ok;
}

/** `capcomd title` */
async function titleCommand({ positionals, values, json }: Cmd): Promise<number> {
  // capcomd title <runId> <agt> <words…>: the driver names an agent (capability agents.title).
  const runId = positionals[1] ?? usage('capcomd title <runId> <agt> "<2-4 words>"');
  const agentId = positionals[2] ?? usage('capcomd title <runId> <agt> "<2-4 words>"');
  const words = positionals.slice(3).join(" ") || (values.title as string | undefined) || usage('title required: capcomd title <runId> <agt> "login redirect"');
  const r = await (await import("../../primitives/ops")).setAgentTitle(runId, agentId, words, { by: "driver", setBy: "driver", ...(values.key ? { key: `driver:${values.key}` } : {}) });
  if (json) out(r); else console.log(r.shown ? `${agentId}: ${r.title}` : `${agentId}: kept "${words}"; the tab still says "${r.title}" (${r.note})`);
  return EXIT.ok;
}

/** `capcomd token` */
async function tokenCommand({ positionals, values, json }: Cmd): Promise<number> {
  // capcomd token revoke <runId> <jti> [--reason R]: kills an in-VM token now (the pump also revokes on exit).
  if (positionals[1] !== "revoke") usage("capcomd token revoke <runId> <jti> [--reason R]");
  const runId = positionals[2] ?? usage("capcomd token revoke <runId> <jti>");
  const jti = positionals[3] ?? usage("capcomd token revoke <runId> <jti>");
  const { client: cl, assertEngine: ae } = await import("../../core/relay");
  await ae();
  const r = await cl().scope.getOrCreate([runId]).revokeToken({ jti, reason: values.reason as string | undefined });
  if (json) out({ runId, jti, ...r }); else console.log(`revoked ${jti}`);
  return EXIT.ok;
}

/** `capcomd tree` */
async function treeCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd tree <runId> [--root agt]");
  const O = await import("../../primitives/ops");
  const r: any = { ...(await O.listScope(runId)), ...(await O.treeOf(runId, values.root as string | undefined)) };
  if (json) out(r);
  else if (process.env.CAPCOMD_TREE_FLAT !== "1") {
    const b = (x: Record<string, number>) => Object.entries(x).map(([k, v]) => `${k}=${v}`).join(",") || "-";
    console.log(`${runId}  budget ${b(r.budget)} (unallocated ${b(r.unallocated)}, spent ${b(r.spent)})  totals: ${r.totals.agents} agents $${r.totals.usd}${(await import("../../subagents/results")).notional(r.totals.notionalUsd)} ${r.totals.turns} turns ${r.totals.wallSeconds}s`);
    console.log((await import("../../subagents/results")).textTree(r.tree, "  "));
  }
  else {
    const b = (x: Record<string, number>) => Object.entries(x).map(([k, v]) => `${k}=${v}`).join(",") || "-";
    console.log(`${runId}  budget ${b(r.budget)} (unallocated ${b(r.unallocated)}, spent ${b(r.spent)})`);
    for (const a of r.agents) console.log(`${"  ".repeat(a.depth + 1)}${a.agentId} [${a.profile ?? "-"}] ${a.status} budget ${b(a.budget)} spent ${b(a.spent)}${a.parent ? ` ← ${a.parent}` : ""}`);
  }
  return EXIT.ok;
}

/** `capcomd grant` */
async function grantCommand({ positionals, values, json }: Cmd): Promise<number> {
  // ADR-019 §4: more budget for a live agent (from its parent's, or the run's), or with no agent, the run's.
  const runId = positionals[1] ?? usage("capcomd grant <runId> [agt] --budget usd=…,turns=…,wallSeconds=… [--key K]");
  let add: Record<string, number> = {};
  try { add = (await import("../../primitives/policy")).parseBudget(values.budget); } catch (e) { usage(`--budget: ${(e as Error).message}`); }
  if (!Object.keys(add).length) usage("capcomd grant <runId> [agt] --budget usd=…,turns=…,wallSeconds=…");
  const r: any = await (await import("../../primitives/ops")).grantBudget(runId, { ...(positionals[2] ? { agentId: positionals[2] } : {}), add, by: "operator", ...(values.key ? { key: String(values.key) } : {}) });
  const b = (x: Record<string, number> = {}) => Object.entries(x).map(([k, v]) => `${k}=${v}`).join(",") || "-";
  if (json) out(r);
  else console.log(`✓ ${r.agentId ?? runId} budget ${b(r.budget)}${r.replayed ? " (already granted)" : ""}; ${r.agentId ? r.from : "the run"} has ${b(r.left)} left${r.agentId ? "" : " to give"}`);
  return EXIT.ok;
}

/** `capcomd skills` */
async function skillsCommand({ json }: Cmd): Promise<number> {
  // The skills `capcomd send --skill` (and the harness API's `skills`) can attach: bundled ones and ~/.claude/skills.
  const list = await (await import("../../agents/skills")).listSkills();
  if (json) out({ skills: list });
  else console.log(list.length ? list.map((s) => `${s.name}  (${s.source})${s.description ? `  ${s.description}` : ""}`).join("\n") : "no skills");
  return EXIT.ok;
}

/** `capcomd task` */
async function taskCommand({ positionals, values, json }: Cmd): Promise<number> {
  const S = await import("../../primitives/state");
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

/** `capcomd kv` */
async function kvCommand({ positionals, values, json }: Cmd): Promise<number> {
  const S = await import("../../primitives/state");
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

export const COMMANDS: Record<string, KernelCommand> = {
  "spawn": spawnCommand,
  "await": awaitCommand,
  "wait-any": awaitCommand,
  "verify": verifyCommand,
  "check": checkCommand,
  "merge": mergeCommand,
  "budget": budgetCommand,
  "send": sendCommand,
  "title": titleCommand,
  "token": tokenCommand,
  "tree": treeCommand,
  "grant": grantCommand,
  "skills": skillsCommand,
  "task": taskCommand,
  "kv": kvCommand,
};
