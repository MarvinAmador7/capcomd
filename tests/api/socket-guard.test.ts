// One harness socket per daemon: a second `capcomd serve` (or a test) must never take over a socket a live daemon is
// serving, nor delete it on the way out. Seen 2026-10-26: a daemon lost ~/.capcomd/harness.sock to another process.
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessSocketInUseError, probeHarnessSocket, serveHarnessSocket, type HarnessSocket } from "../../src/api/socket";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource } from "../../src/api/source";
import { privateHarnessSocket, staleSocket } from "../helpers/harness-socket";

const app = () => harnessApp({ source: memorySource(), clients: () => [], state: harnessState(null) }).fetch;
const health = async (sock: string) => (await (await fetch("http://localhost/v1/health", { unix: sock } as RequestInit)).json()) as { api: string; version: string };
const ino = (p: string) => lstatSync(p).ino;
const open: HarnessSocket[] = [];
afterAll(() => { for (const h of open) h.close(); });

test("probe: absent, live (with the daemon's version), stale (refused / not a socket)", async () => {
	const sock = privateHarnessSocket();
	expect((await probeHarnessSocket(sock)).state).toBe("absent");
	const h = await serveHarnessSocket(sock, app()); open.push(h);
	expect(await probeHarnessSocket(sock)).toMatchObject({ state: "live", version: "test" });
	const dead = privateHarnessSocket();
	staleSocket(dead);
	expect(await probeHarnessSocket(dead)).toMatchObject({ state: "stale", reason: "connection refused" });
	const file = privateHarnessSocket();
	writeFileSync(file, "x");
	expect(await probeHarnessSocket(file)).toMatchObject({ state: "stale", reason: "not a socket" });
});

test("a live socket: refused with its path, the daemon's version and how to pick another; the file is untouched", async () => {
	const sock = privateHarnessSocket();
	const live = await serveHarnessSocket(sock, app()); open.push(live);
	const before = ino(sock);
	const e = await serveHarnessSocket(sock, () => new Response("intruder")).catch((x) => x);
	expect(e).toBeInstanceOf(HarnessSocketInUseError);
	expect(e.message).toContain(sock);
	expect(e.message).toContain("version test");
	expect(e.message).toContain("--harness-socket");
	expect(e.message).toContain("CAPCOMD_HARNESS_SOCKET");
	expect(ino(sock)).toBe(before);
	expect(live.owned()).toBe(true);
	expect((await health(sock)).api).toBe("harness.v1");
});

test("something that accepts but never answers also counts as in use", async () => {
	const sock = privateHarnessSocket();
	const { createServer } = await import("node:net");
	const hole = createServer(() => {}).listen(sock);
	await new Promise((r) => hole.once("listening", r));
	try {
		const s = await probeHarnessSocket(sock, 300);
		expect(s.state).toBe("live");
		expect(await serveHarnessSocket(sock, app()).catch((x) => x)).toBeInstanceOf(HarnessSocketInUseError);
		expect(existsSync(sock)).toBe(true);
	} finally { hole.close(); }
});

test("a stale socket (dead daemon) or a plain file is replaced, and the new socket is 0600 and serves", async () => {
	for (const make of [staleSocket, (p: string) => writeFileSync(p, "x")]) {
		const sock = privateHarnessSocket();
		make(sock);
		const h = await serveHarnessSocket(sock, app()); open.push(h);
		expect(lstatSync(sock).isSocket()).toBe(true);
		expect(lstatSync(sock).mode & 0o777).toBe(0o600);
		expect((await health(sock)).api).toBe("harness.v1");
	}
});

test("release/close remove our socket, but never another daemon's that replaced it", async () => {
	const sock = privateHarnessSocket();
	const ours = await serveHarnessSocket(sock, app());
	expect(ours.owned()).toBe(true);
	ours.close();
	expect(existsSync(sock)).toBe(false);

	const mine = await serveHarnessSocket(sock, app());
	// Another daemon's socket lands on the same path (e.g. it started while ours was hung).
	const other = join(dirname(sock), "other.sock");
	const foreign = Bun.serve({ unix: other, fetch: () => new Response("") });
	renameSync(other, sock);
	const theirs = ino(sock);
	try {
		expect(mine.owned()).toBe(false);
		mine.release();
		mine.close();
		expect(existsSync(sock)).toBe(true);
		expect(ino(sock)).toBe(theirs);
		expect((await fetch("http://localhost/", { unix: sock } as RequestInit)).status).toBe(200);
	} finally { foreign.stop(true); }
});
