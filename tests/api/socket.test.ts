import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { harnessSocketPath, serveHarnessSocket } from "../../src/api/socket";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";

const dir = mkdtempSync(join(tmpdir(), "hs-"));
const sock = join(dir, "harness.sock");
const server = serveHarnessSocket(sock, harnessApp({ source: memorySource(), clients: () => [] }).fetch);
afterAll(() => server.stop(true));

test("socket path: flag > env > config > ~/.capcomd/harness.sock", () => {
	expect(harnessSocketPath({ flag: "/a.sock", env: { CAPCOMD_HARNESS_SOCKET: "/b.sock" } })).toBe("/a.sock");
	expect(harnessSocketPath({ env: { CAPCOMD_HARNESS_SOCKET: "/b.sock" }, config: { harness: { socket: "/c.sock" } } })).toBe("/b.sock");
	expect(harnessSocketPath({ env: {}, config: { harness: { socket: "/c.sock" } } })).toBe("/c.sock");
	expect(harnessSocketPath({ env: { CAPCOMD_HOME: "/h" } })).toBe("/h/harness.sock");
});

test("the socket is 0600", () => expect(statSync(sock).mode & 0o777).toBe(0o600));

// Raw HTTP so the exact Host header reaches the server (fetch may rewrite it).
const raw = (host: string) => new Promise<string>((res, rej) => {
	const c = connect(sock, () => c.write(`GET /v1/health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
	let out = ""; c.on("data", (d) => (out += d)); c.on("end", () => res(out)); c.on("error", rej);
});

test("accepts Host: localhost and a hex-encoded socket path as Host", async () => {
	const hex = Buffer.from(sock).toString("hex");
	for (const host of ["localhost", hex, `${hex}:80`]) {
		const r = await raw(host);
		expect(r.startsWith("HTTP/1.1 200")).toBe(true);
		expect(r).toContain('"api":"harness.v1"');
	}
});
