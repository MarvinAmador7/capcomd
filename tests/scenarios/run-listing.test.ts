// How runs are listed, against a real engine, in a capcomd home of the file's own (its runs index is this file's alone).
//
// Reading runs never creates actors. The runs index (state/runs.jsonl) can list runs this engine never had (another
// engine recorded them, e.g. a live e2e script on its own port sharing the capcomd home); the menu bar's daemon stream
// lists every run twice a second, and listing used getOrCreate, so each such run got an empty scope actor. Now a run
// whose scope doesn't exist is listed as "unknown", with no agents and no events, and nothing is created; the lookup
// is one engine request (a plain `get` retries not_found for ~2.4 s, logging each retry).
//
// A run cancelled while its agent works reads "cancelled" everywhere: the cancel's answer, `capcomd status` (what the
// TUI shows), the harness API's run list, capcomd_runs and the agent's own status. And capcomd_runs answers quickly.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addClient, loadClients } from "../../src/api/clients";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { client, existingActor, isActorNotFound } from "../../src/core/relay";
import { pendingMerges, runsIndexPath } from "../../src/primitives/ops";
import { world, type World } from "./harness";

let w: World;
const home = mkdtempSync(join(tmpdir(), "capcomd-listnc-home-"));
beforeAll(async () => { w = await world("listnc", { CAPCOMD_HOME: home }); }, 120_000);
afterAll(async () => { await w?.stop(); }, 60_000);

/** True when the engine has a scope actor for the run (a lookup only: `resolve` on a `get` handle creates nothing). */
const scopeExists = async (runId: string) => (client().scope as any).get([runId]).resolve().then(() => true, (e: unknown) => {
	if (isActorNotFound(e)) return false;
	throw e;
});

test("a run in the index with no scope on this engine is listed as unknown, and no read creates its scope", async () => {
	const made = await w.cj(["run", "new", "--label", "real"]);
	expect(made.code).toBe(0);
	const real = made.j.runId as string;
	const ghost = `run-ghost${Date.now().toString(36)}`;
	expect(runsIndexPath().startsWith(home)).toBe(true);
	appendFileSync(runsIndexPath(), JSON.stringify({ runId: ghost, label: "another engine's run", repo: null, cwd: home, createdAt: Date.now() }) + "\n");
	expect(await scopeExists(ghost)).toBe(false);

	const src = rivetSource();
	const t0 = Date.now();
	const runs = await src.runs();
	expect(Date.now() - t0).toBeLessThan(2000); // one lookup, not the ~2.4 s of not_found retries
	expect(runs.find((r) => r.id === ghost)).toMatchObject({ state: "unknown", label: "another engine's run", goal: null });
	expect(runs.find((r) => r.id === real)).toMatchObject({ state: "new", label: "real" });

	// Every read of the run: empty, never a created actor.
	expect(await src.agents(ghost)).toEqual([]);
	expect(await src.agents("run-notindexed")).toBeNull();
	expect(await src.events(ghost, 0)).toEqual([]);
	expect(await src.transcript(ghost, "agt-x", 0, 10)).toBeNull();
	expect(await src.thread(ghost, "agt-x", 0, 10)).toBeNull();
	expect(await src.threadAfter(ghost, 0, 10)).toEqual([]);
	expect(await src.threadHead(ghost)).toBe(0);
	expect(await src.attachment(ghost, "att-x")).toBeNull();
	expect(await src.approvals(ghost)).toEqual([]);
	expect(await src.projects()).toBeArray();
	expect(await pendingMerges(ghost)).toEqual([]);
	const { runs: mcpRuns } = await import("../../src/mcp/driver");
	expect((await mcpRuns({ limit: 10 })).runs.find((r: any) => r.runId === ghost)).toMatchObject({ agents: {} });

	// The menu bar's daemon stream, several ticks, and the list route.
	const clients = join(home, "harness-clients.json");
	const { token } = addClient("menubar", ["read"], clients);
	const app = harnessApp({ source: src, clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
	const auth = { authorization: `Bearer ${token}` };
	const res = await app.request("/v1/streams/daemon/events", { headers: auth });
	const reader = res.body!.getReader();
	// One read in flight at a time (a second read() while one is pending loses the chunk the first one gets). Read
	// until the ghost run is listed (a slow CI runner can take seconds), then a few more ticks of polling.
	let txt = "", pending: Promise<any> | null = null;
	for (let end = Date.now() + 15_000; Date.now() < end;) {
		pending ??= reader.read();
		const x: any = await Promise.race([pending, Bun.sleep(100).then(() => null)]);
		if (!x) continue;
		pending = null;
		if (x.done) break;
		const seen = txt.includes(ghost);
		txt += new TextDecoder().decode(x.value);
		if (!seen && txt.includes(ghost)) end = Math.min(end, Date.now() + 600);
	}
	await reader.cancel().catch(() => {});
	expect(txt).toContain(ghost);
	const list = (await (await app.request("/v1/runs", { headers: auth })).json()) as any;
	expect((list.runs ?? list).find((r: any) => r.id === ghost)).toMatchObject({ state: "unknown" });

	expect(await scopeExists(ghost)).toBe(false);
	expect(await scopeExists(real)).toBe(true);
	expect(await existingActor("scope", [ghost])).toBeNull();
}, 120_000);

test("a run cancelled mid-work is cancelled, not failed or idle; its agent is cancelled", async () => {
  const runId = (await w.cj(["run", "new", "--label", "cancel me", "--key", `rc-${Date.now()}`])).j.runId as string;
  const slow = w.script("rc-slow", "sleep 60; capcomd result --summary late >/dev/null");
  const agentId = (await w.cj(["spawn", runId, "--profile", "worker", "--task", "long job", "--key", "slow", "--contract", JSON.stringify({ script: slow })])).j.agentId as string;
  const { client } = await import("../../src/core/relay");
  for (let i = 0; i < 100; i++) {
    const agents: any[] = await client().scope.getOrCreate([runId]).listAgents({});
    if (agents.some((a) => a.agentId === agentId && a.status === "running")) break;
    await Bun.sleep(100);
  }
  const c = await w.cj(["cancel", runId, "--reason", "changed my mind"]);
  expect(c.code).toBe(0);
  expect(c.j).toMatchObject({ cancelled: [agentId], runEnded: true });

  const st = (await w.cj(["status", runId])).j.run;
  expect(st.state).toBe("cancelled");
  expect(st.scope).toMatchObject({ state: "cancelled", byStatus: { cancelled: 1 } });

  const { rivetSource } = await import("../../src/api/rivet-source");
  const listed = (await rivetSource().runs()).find((r: any) => r.id === runId);
  expect(listed?.state).toBe("cancelled");

  const D = await import("../../src/mcp/driver");
  const t0 = Date.now();
  const mine = (await D.runs({ limit: 8 })).runs.find((r: any) => r.runId === runId);
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(mine).toMatchObject({ state: "cancelled", agents: { cancelled: 1 }, pendingApprovals: [] });
  const tree: any = await D.tree({ runId });
  expect(JSON.stringify(tree)).toContain('"status":"cancelled"');
}, 120_000);
