// `capcomd clients pair --app <name>`: the token the capcomd app makes for itself (no copy and paste).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_SCOPES, addClient, authenticate, loadClients, pairClient } from "../../src/api/clients";
import { capcomd } from "../helpers/engine";
import pkg from "../../package.json" with { type: "json" };

const dir = mkdtempSync(join(tmpdir(), "capcomd-pair-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pairClient", () => {
	test("mints a token with the app's scopes that authenticates, and revokes only that app's earlier pairing", () => {
		const path = join(dir, "unit.json");
		const manual = addClient("mac-app", ["read"], path);   // a `clients add` token with the same name stays
		const other = pairClient("other-app", APP_SCOPES, path);
		const first = pairClient("mac-app", undefined, path);
		expect(first.client).toMatchObject({ name: "mac-app", app: "mac-app", scopes: ["read", "steer", "approve", "configure"], revokedAt: null });
		expect(first.revoked).toEqual([]);
		expect(first.token).toMatch(/^cch_[A-Za-z0-9_-]{43}$/);
		expect(authenticate(`Bearer ${first.token}`, loadClients(path))?.clientId).toBe(first.client.id);

		const second = pairClient("mac-app", undefined, path);
		expect(second.revoked).toEqual([first.client.id]);
		const all = loadClients(path);
		expect(authenticate(`Bearer ${first.token}`, all)).toBeNull();
		expect(authenticate(`Bearer ${second.token}`, all)?.clientId).toBe(second.client.id);
		expect(authenticate(`Bearer ${manual.token}`, all)?.clientId).toBe(manual.client.id);
		expect(authenticate(`Bearer ${other.token}`, all)?.clientId).toBe(other.client.id);
		expect(JSON.stringify(all)).not.toContain(second.token);   // only its hash is kept
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("refuses odd app names and unknown scopes", () => {
		const path = join(dir, "bad.json");
		expect(() => pairClient("", undefined, path)).toThrow(/app name/);
		expect(() => pairClient("my app", undefined, path)).toThrow(/app name/);
		expect(() => pairClient("-x", undefined, path)).toThrow(/app name/);
		expect(() => pairClient("mac-app", ["read", "root" as never], path)).toThrow(/unknown scope root/);
		expect(loadClients(path)).toEqual([]);
	});
});

describe("capcomd clients pair", () => {
	const env = (home: string) => ({ CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" });

	test("prints the token alone on stdout, and nothing on stderr", async () => {
		const home = join(dir, "cli");
		const r = await capcomd(["clients", "pair", "--app", "mac-app"], env(home));
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^cch_[A-Za-z0-9_-]{43}\n$/);
		expect(r.stderr).toBe("");
		const token = r.stdout.trim();
		const clients = loadClients(join(home, "harness-clients.json"));
		expect(clients).toHaveLength(1);
		expect(authenticate(`Bearer ${token}`, clients)?.scopes).toEqual(APP_SCOPES);
	});

	test("--json: the token, its client, what it revoked and the CLI's version", async () => {
		const home = join(dir, "cli-json");
		const a = await capcomd(["clients", "pair", "--app", "mac-app", "--json"], env(home));
		const b = await capcomd(["clients", "pair", "--app", "mac-app", "--scopes", "read,approve", "--json"], env(home));
		expect(a.code).toBe(0);
		expect(b.code).toBe(0);
		const first = JSON.parse(a.stdout), second = JSON.parse(b.stdout);
		expect(first).toMatchObject({ schema: "relay.v1", ok: true, name: "mac-app", app: "mac-app", scopes: APP_SCOPES, revoked: [], version: pkg.version });
		expect(second).toMatchObject({ scopes: ["read", "approve"], revoked: [first.id] });
		expect(second.token).not.toBe(first.token);
		const list = await capcomd(["clients", "list"], env(home));
		expect(list.stdout).not.toContain(second.token);
		expect(JSON.parse(list.stdout).map((c: { id: string; revokedAt: string | null }) => [c.id, c.revokedAt === null])).toEqual([[first.id, false], [second.id, true]]);
	});

	test("without --app, or with a bad name: a usage error, no token", async () => {
		const home = join(dir, "cli-bad");
		const none = await capcomd(["clients", "pair", "--json"], env(home));
		expect(none.code).toBe(2);
		expect(JSON.parse(none.stdout).error.code).toBe("usage");
		const bad = await capcomd(["clients", "pair", "--app", "a b"], env(home));
		expect(bad.code).toBe(2);
		expect(bad.stdout).toBe("");
		expect(loadClients(join(home, "harness-clients.json"))).toEqual([]);
	});
});
