// harness.v1 agent threads: GET …/thread (write cursor, paging, 404s), live agent.thread_item_changed frames (?thread=1:
// ephemeral, no SSE id, opt-in, coalesced, resumable through the route), the raw media routes, and the writer's
// chunking. The adapters and blocks/1 are tested in packages/agent-thread.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { EventData, ThreadItem, ThreadPage } from "../../src/api/contract";
import { HarnessEvent } from "../../src/api/envelope";
import { INLINE_TEXT_MAX_BYTES } from "../../src/api/inline-cap";
import { harnessApp, servedType } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { CALL_MAX_BYTES, itemCalls } from "../../src/agents/thread-store";
import { ITEM_MAX_BYTES, threadBuilder } from "../../packages/agent-thread/src/index";

const dir = mkdtempSync(join(tmpdir(), "harness-thread-"));
const cpath = join(dir, "clients.json");
const token = addClient("reader", ["read"], cpath).token;
const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-26T07:00:00.000Z" };
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

/** A lead's thread as the daemon stores it: the builder's drafts with a seq per write and an order per item. */
function store() {
	const items: any[] = [];
	const order = new Map<string, number>();
	let seq = 0;
	const put = (agentId: string, d: any) => { seq++; const o = order.get(d.id) ?? seq; order.set(d.id, o); const i = items.findIndex((x) => x.id === d.id); const row = { ...d, seq, order: o, agentId }; if (i >= 0) items.splice(i, 1); items.push(row); return row; };
	return { items, put };
}

function app(o: { threadMs?: number } = {}) {
	const agent: any = { id: "a1", runId: "run-1", parent: null, depth: 0, profile: "lead", status: "running", text: "Agent a1 is now running.", activity: null, task: "t", taskAttachment: null, result: null, workspace: null, provider: "claude", model: null, effort: null, updatedAt: null };
	const st = store();
	const src = memorySource({
		runs: [run], agents: { "run-1": [agent] }, items: { "run-1": st.items },
		events: { "run-1": [{ seq: 1, at: Date.now(), type: "RUN_NEW", agentId: null, data: { budget: {}, label: "demo" } }] },
		attachments: { "run-1": { "att-00000000000000000000000a": { mime: "image/png", bytes: PNG }, "att-00000000000000000000000b": { mime: "image/png", bytes: new TextEncoder().encode('<svg onload="alert(1)"/>') } } },
		files: { "run-1": { a1: { "charts/rows.png": PNG, "notes.md": new TextEncoder().encode("# hi"), "bin.dat": new Uint8Array([0, 1, 2, 255]) } } },
	});
	const a = harnessApp({ source: src, clients: () => loadClients(cpath), heartbeatMs: 60_000, pollMs: 10, threadMs: o.threadMs ?? 100, state: harnessState(null) });
	const b = threadBuilder({ cli: "claude", idPrefix: "itm-a1-x", now: () => 0 });
	const feed = (ev: unknown) => b.event(ev).map((d) => st.put("a1", d));
	return { st, feed, req: (p: string, h: Record<string, string> = {}) => a.request(p, { headers: { authorization: `Bearer ${token}`, ...h } }) };
}
async function read(res: Response, ms: number, until?: RegExp) {
	const r = res.body!.getReader(); const dec = new TextDecoder(); let t = ""; const end = Date.now() + ms;
	let pending: Promise<any> | null = null;
	while (Date.now() < end && !(until && until.test(t))) {
		pending ??= r.read();
		const x = await Promise.race([pending, new Promise<any>((ok) => setTimeout(() => ok(null), 20))]);
		if (!x) continue;
		pending = null;
		if (x.value) t += dec.decode(x.value);
		if (x.done) break;
	}
	r.cancel().catch(() => {});
	return t;
}
const frames = (t: string) => t.split("\n\n").filter((f) => f.includes("event: agent.thread_item_changed\n"));
const env = (f: string) => JSON.parse(f.slice(f.indexOf("data: ") + 6));
const toolUse = (id: string, name = "Bash", input: unknown = { command: "bun test" }) => ({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, extra: Record<string, unknown> = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra });
const say = (text: string) => ({ type: "assistant", message: { id: `m-${text.length}-${text.slice(0, 5)}`, content: [{ type: "text", text }] } });

describe("GET …/thread", () => {
	test("items by write cursor: a tool call is seen open, then again done; 404 for an unknown agent or run", async () => {
		const { req, feed } = app();
		feed(say("## Plan\n\n- one\n- two"));
		feed(toolUse("t1", "Glob", { pattern: "*.ts" }));
		const first = await (await req("/v1/runs/run-1/agents/a1/thread")).json() as any;
		expect(ThreadPage.safeParse(first).success).toBe(true);
		expect(first.items.map((i: any) => [i.kind, i.status, i.rev])).toEqual([["say", "done", 1], ["tool", "open", 1]]);
		expect(first.next).toBeNull();
		const cursor = first.items.at(-1).seq;
		feed(toolResult("t1", { tool_use_result: { durationMs: 412 } }));
		const later = await (await req(`/v1/runs/run-1/agents/a1/thread?after=${cursor}`)).json() as any;
		expect(later.items).toMatchObject([{ kind: "tool", status: "done", rev: 2, durationMs: 412, order: first.items[1].order }]);
		expect(later.items[0].seq).toBeGreaterThan(cursor);
		expect((await req("/v1/runs/run-1/agents/nope/thread")).status).toBe(404);
		expect((await req("/v1/runs/run-x/agents/a1/thread")).status).toBe(404);
	});

	test("paging: `limit`, then `next` until null", async () => {
		const { req, feed } = app();
		for (let i = 0; i < 5; i++) feed(say(`message ${i}`));
		const p1 = await (await req("/v1/runs/run-1/agents/a1/thread?limit=2")).json() as any;
		expect(p1.items.length).toBe(2);
		const p2 = await (await req(`/v1/runs/run-1/agents/a1/thread?limit=2&after=${p1.next}`)).json() as any;
		const p3 = await (await req(`/v1/runs/run-1/agents/a1/thread?limit=2&after=${p2.next}`)).json() as any;
		expect([...p1.items, ...p2.items, ...p3.items].map((i: any) => i.text)).toEqual([0, 1, 2, 3, 4].map((i) => `message ${i}`));
		expect(p3.next).toBeNull();
	});

	test("the per-item cap is the daemon's inline text cap", () => {
		expect(ITEM_MAX_BYTES).toBe(INLINE_TEXT_MAX_BYTES);
	});
});

describe("live agent.thread_item_changed frames (?thread=1)", () => {
	test("ephemeral, no SSE id, the full item as the route serves it, on the full stream and the lifecycle feed", async () => {
		for (const path of ["/v1/streams/run-1/events?thread=1", "/v1/streams/run-1/events?feed=lifecycle&thread=1"]) {
			const { req, feed, st } = app();
			const res = await req(path);
			setTimeout(() => feed(toolUse("t1")), 40);
			setTimeout(() => feed(toolResult("t1")), 250);
			const t = await read(res, 1500, /"status":"done"/);
			const fs = frames(t);
			expect(fs.length).toBe(2);
			for (const f of fs) {
				expect(f).not.toMatch(/^id: /m);
				const e = env(f);
				expect(HarnessEvent.safeParse(e).success).toBe(true);
				expect(EventData["agent.thread_item_changed"].safeParse(e.data).success).toBe(true);
				expect(ThreadItem.safeParse(e.data.item).success).toBe(true);
				expect(e).toMatchObject({ durability: "ephemeral", entitySeq: 0, entity: "a1", agentId: "a1", type: "agent.thread_item_changed" });
			}
			expect(fs.map((f) => [env(f).data.item.status, env(f).data.item.rev])).toEqual([["open", 1], ["done", 2]]);
			expect(env(fs[1]!).data.item).toEqual(st.items.at(-1));
		}
	});

	test("opt-in: no thread frames without ?thread=1, and never replayed", async () => {
		const { req, feed } = app();
		for (const path of ["/v1/streams/run-1/events", "/v1/streams/run-1/events?feed=lifecycle&activity=1"]) {
			const res = req(path);
			setTimeout(() => feed(say(`hello ${path}`)), 30);
			const t = await read(await res, 400);
			expect(t).toContain("snapshot.end");
			expect(t).not.toContain("agent.thread_item_changed");
		}
		expect(((await (await req("/v1/events?scope=run-1")).json()) as any[]).some((e) => e.type === "agent.thread_item_changed")).toBe(false);
		expect(((await (await req("/v1/runs/run-1/lifecycle")).json()) as any[]).some((e) => e.type === "agent.thread_item_changed")).toBe(false);
	});

	test("coalesced: many revs of one item between polls are one frame with the latest rev", async () => {
		const { req, st } = app({ threadMs: 200 });
		const res = await req("/v1/streams/run-1/events?thread=1");
		const burst = (async () => {
			await Bun.sleep(30);
			for (let rev = 1; rev <= 30; rev++) { st.put("a1", { ...ThreadItem.parse({ id: "itm-a1-p", rev, seq: 0, order: 0, agentId: "a1", kind: "plan", status: rev < 30 ? "open" : "done", at: new Date(0).toISOString(), durationMs: null, text: `rev ${rev}`, blocks: [], format: "blocks/1", redacted: false, tool: null, error: null, truncated: null, child: null }) }); await Bun.sleep(5); }
		})();
		const t = await read(res, 1200, /"text":"rev 30"/);
		await burst;
		const fs = frames(t);
		expect(fs.length).toBeGreaterThanOrEqual(1);
		expect(fs.length).toBeLessThanOrEqual(4); // ~150 ms of writes at one poll per 200 ms, not 30
		expect(env(fs.at(-1)!).data.item.rev).toBe(30);
		const revs = fs.map((f) => env(f).data.item.rev);
		expect([...revs].sort((a, b) => a - b)).toEqual(revs);
	});

	test("resume: frames start at connect; what came before is read from the route by cursor", async () => {
		const { req, feed } = app();
		feed(say("before the stream"));
		const res = await req("/v1/streams/run-1/events?thread=1");
		setTimeout(() => feed(say("after connecting")), 40);
		const t = await read(res, 800, /after connecting/);
		expect(frames(t).map((f) => env(f).data.item.text)).toEqual(["after connecting"]);
		const page = await (await req("/v1/runs/run-1/agents/a1/thread?after=0")).json() as any;
		expect(page.items.map((i: any) => i.text)).toEqual(["before the stream", "after connecting"]);
	});
});

describe("media routes", () => {
	test("attachments: bytes with the sniffed type, nosniff and a CSP; an svg claiming image/png is text", async () => {
		const { req } = app();
		const png = await req("/v1/runs/run-1/attachments/att-00000000000000000000000a/content");
		expect(png.status).toBe(200);
		expect(png.headers.get("content-type")).toBe("image/png");
		expect(png.headers.get("x-content-type-options")).toBe("nosniff");
		expect(png.headers.get("content-security-policy")).toContain("sandbox");
		expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
		const svg = await req("/v1/runs/run-1/attachments/att-00000000000000000000000b/content");
		expect(svg.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect((await req("/v1/runs/run-1/attachments/att-00000000000000000000ffff/content")).status).toBe(404);
		const json = await (await req("/v1/runs/run-1/attachments/att-00000000000000000000000a")).json() as any;
		expect(json).toMatchObject({ encoding: "base64", attachment: { mediaType: "image/png" } });
	});

	test("workspace files: normalized relative paths only, regular files, sniffed types", async () => {
		const { req } = app();
		const img = await req("/v1/runs/run-1/agents/a1/workspace?path=charts/rows.png");
		expect([img.status, img.headers.get("content-type"), img.headers.get("content-disposition")]).toEqual([200, "image/png", "inline"]);
		expect((await req("/v1/runs/run-1/agents/a1/workspace?path=notes.md")).headers.get("content-type")).toBe("text/plain; charset=utf-8");
		const bin = await req("/v1/runs/run-1/agents/a1/workspace?path=bin.dat");
		expect([bin.headers.get("content-type"), bin.headers.get("content-disposition")]).toEqual(["application/octet-stream", "attachment"]);
		for (const p of ["../secret", "charts/../../x", "/etc/passwd", "./notes.md", "charts//rows.png", ".git/config", "%2e%2e/x", ""])
			expect([p, (await req(`/v1/runs/run-1/agents/a1/workspace?path=${encodeURIComponent(p)}`)).status]).toEqual([p, 422]);
		expect((await req("/v1/runs/run-1/agents/a1/workspace?path=missing.png")).status).toBe(404);
		expect((await req("/v1/runs/run-1/agents/zz/workspace?path=notes.md")).status).toBe(404);
	});

	test("served types never come from the agent's claim", () => {
		expect(servedType(PNG, "video/mp4")).toEqual({ type: "image/png", inline: true });
		expect(servedType(new TextEncoder().encode("<html><script>"), "image/png")).toEqual({ type: "text/plain; charset=utf-8", inline: true });
		expect(servedType(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74]), "video/mp4")).toEqual({ type: "video/mp4", inline: true });
		expect(servedType(new Uint8Array([0xff, 0xfe, 0]), null)).toEqual({ type: "application/octet-stream", inline: false });
	});
});

describe("thread writes", () => {
	test("calls stay under the cap, in order; images go one per call", () => {
		const big = (i: number) => ({ id: `i${i}`, rev: 1, text: "x".repeat(100_000) }) as any;
		const calls = itemCalls([big(1), big(2), big(3), { id: "s", rev: 1, text: "y" } as any], [{ id: "att-1", sha256: "", bytes: 1, mime: "image/png", base64: "AA==" }]);
		expect(calls[0]).toEqual({ items: [], attachments: [expect.objectContaining({ id: "att-1" })] });
		expect(calls.slice(1).flatMap((c) => c.items.map((i) => i.id))).toEqual(["i1", "i2", "i3", "s"]);
		for (const c of calls.slice(1)) expect(c.items.length === 1 || Buffer.byteLength(JSON.stringify(c.items)) <= CALL_MAX_BYTES).toBe(true);
	});
});
