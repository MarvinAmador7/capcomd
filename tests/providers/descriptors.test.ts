// ADR-021 §1: one descriptor per provider in the registry drives the engine's capability checks, the places clients
// see (run options, logins, environments, the API's sandbox names) and GET /v1/sandboxes. And §3's machine lists:
// what each provider's list reports for the resources route (created and delete-after times).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESCRIPTORS, isListedProvider, LISTED_PROVIDERS, PROVIDER_LABEL, PROVIDERS, RESOURCE_ACTIONS, sandboxCaps, SERVED_ACTIONS } from "../../src/providers/registry";
import { RUN_SANDBOXES, SANDBOX_LABEL } from "../../src/api/run-options";
import { SETTINGS_SANDBOXES } from "../../src/api/settings";
import { CreateRunBody, SandboxDescriptor, SandboxName } from "../../src/api/contract";
import { servedDescriptor } from "../../src/api/sandboxes";
import { DockerProvider, dockerTime } from "../../src/providers/docker";
import { BoxdProvider, type BoxdLike } from "../../src/providers/boxd";
import { MACHINE_PREFIX } from "../../src/providers/sandbox";

describe("provider descriptors (registry)", () => {
	test("docker and boxd are listed, in that order; the fakes aren't", () => {
		expect(LISTED_PROVIDERS).toEqual(["docker", "boxd"]);
		expect(DESCRIPTORS.map((d) => [d.name, d.listed])).toEqual([["docker", true], ["boxd", true], ["fake", false], ["fake-host", false]]);
		for (const n of ["fake", "fake-host", "nope", "__proto__", "toString"]) expect(isListedProvider(n)).toBe(false);
		for (const d of DESCRIPTORS) expect(PROVIDERS[d.name as keyof typeof PROVIDERS].name).toBe(d.name as never);
	});
	test("every list of places is derived from the listed descriptors", () => {
		expect([...RUN_SANDBOXES]).toEqual([...LISTED_PROVIDERS]);
		expect([...SETTINGS_SANDBOXES]).toEqual([...LISTED_PROVIDERS]);
		expect(SANDBOX_LABEL).toEqual({ docker: "Local", boxd: "Cloud" });
		expect(PROVIDER_LABEL).toEqual(Object.fromEntries(LISTED_PROVIDERS.map((n) => [n, PROVIDERS[n].label])) as never);
	});
	test("the API's sandbox names are strings checked against the listed providers (wire-compatible)", () => {
		for (const n of ["docker", "boxd"]) expect(SandboxName.safeParse(n).success).toBe(true);
		for (const n of ["fake", "fake-host", "VM", "Docker", ""]) expect(SandboxName.safeParse(n).success).toBe(false);
		expect(CreateRunBody.parse({ goal: "g", sandbox: "boxd" }).sandbox).toBe("boxd");
		expect(CreateRunBody.safeParse({ goal: "g", sandbox: "fake-host" }).success).toBe(false);
	});
	test("caps: the ADR-020 five plus idleLifetime and shell; no costs; settings without egressDefault", () => {
		expect(PROVIDERS.boxd.caps).toEqual({ isolation: "vm", snapshots: true, hostBoundSecrets: true, egressAllowlist: true, interactive: true, idleLifetime: "platform", shell: true });
		expect(PROVIDERS.docker.caps).toEqual({ isolation: "container", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true, idleLifetime: "sweep", shell: true });
		for (const n of ["fake", "fake-host"] as const) expect(PROVIDERS[n].caps).toMatchObject({ isolation: "host", idleLifetime: "none", shell: false });
		for (const d of DESCRIPTORS) {
			expect(Object.keys(d.caps)).not.toContain("costs");
			expect(d.settings).not.toContain("egressDefault" as never);
			for (const a of d.actions) expect(RESOURCE_ACTIONS).toContain(a);
		}
		expect(sandboxCaps({ CAPCOMD_SANDBOX: "docker" })).toBe(PROVIDERS.docker.caps);
	});
	test("served descriptors: the ADR's shape, actions limited to what this daemon serves (open_terminal, delete)", () => {
		expect(SERVED_ACTIONS).toEqual(["open_terminal", "delete"]);
		const boxd = servedDescriptor(PROVIDERS.boxd);
		expect(boxd).toEqual({
			name: "boxd", descriptorVersion: 1, label: "Cloud", kind: "cloud", vendor: "boxd", title: "Cloud · boxd", mark: "boxd", listed: true,
			caps: { isolation: "vm", snapshots: true, hostBoundSecrets: true, egressAllowlist: true, interactive: true, idleLifetime: "platform", shell: true },
			settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"], actions: ["open_terminal", "delete"],
		});
		expect(PROVIDERS.boxd.actions).toEqual(["open_terminal", "delete"]);
		expect(servedDescriptor(PROVIDERS.docker)).toMatchObject({ name: "docker", label: "Local", kind: "local", vendor: "Docker", title: "Local · Docker", mark: "docker" });
		for (const d of DESCRIPTORS) expect(SandboxDescriptor.strict().safeParse(servedDescriptor(d)).success).toBe(true);
	});
});

describe("machine lists for the resources route", () => {
	test("docker: created time from `docker ps`, delete-after from capcomd's sweep ledger, capcomd's prefix only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "capcomd-desc-"));
		const bin = join(dir, "docker");
		// A stub docker CLI: only `ps` answers (nothing here talks to a real Docker).
		writeFileSync(bin, `#!/bin/sh\nif [ "$1" = ps ]; then printf 'relay-aaaaaaaaaaaaaaaa\\trunning\\t2026-10-27 09:12:03 +0000 UTC\\nrelay-bbbbbbbbbbbbbbbb\\texited\\tbogus\\nother-cccc\\trunning\\t2026-10-27 09:12:03 +0000 UTC\\n'; exit 0; fi\necho "unexpected: $*" >&2; exit 1\n`);
		chmodSync(bin, 0o755);
		const ledger = join(dir, "ttl.json");
		writeFileSync(ledger, JSON.stringify({ "relay-aaaaaaaaaaaaaaaa": Date.parse("2026-10-27T10:12:03.000Z") }));
		const rows = await new DockerProvider({ bin, ledgerPath: ledger }).list(MACHINE_PREFIX);
		expect(rows).toEqual([
			{ id: "relay-aaaaaaaaaaaaaaaa", name: "relay-aaaaaaaaaaaaaaaa", state: "running", createdAt: Date.parse("2026-10-27T09:12:03.000Z"), deleteAt: Date.parse("2026-10-27T10:12:03.000Z") },
			{ id: "relay-bbbbbbbbbbbbbbbb", name: "relay-bbbbbbbbbbbbbbbb", state: "exited", createdAt: null, deleteAt: null },
		]);
		expect(dockerTime("2026-10-27 11:12:03 +0200 CEST")).toBe(Date.parse("2026-10-27T09:12:03.000Z"));
		expect(dockerTime(undefined)).toBeNull();
	});
	test("boxd: created and delete-after times from the platform, capcomd's prefix only", async () => {
		const client = { machines: { list: async () => [
			{ id: "m_1", name: "relay-3f9c2a1b7e5d4c60", status: "running", createdAt: new Date("2026-10-27T09:12:03.000Z"), deleteAt: new Date("2026-10-27T10:22:03.000Z") },
			{ id: "m_2", name: "someone-else", status: "running", createdAt: null, deleteAt: null },
			{ id: "m_3", name: "relay-0000000000000000", status: "hibernated", createdAt: null, deleteAt: null },
		] } } as unknown as BoxdLike;
		const p = new BoxdProvider({ client, dbPath: ":memory:", keepaliveMs: 0 });
		expect(await p.list(MACHINE_PREFIX)).toEqual([
			{ id: "m_1", name: "relay-3f9c2a1b7e5d4c60", state: "running", createdAt: Date.parse("2026-10-27T09:12:03.000Z"), deleteAt: Date.parse("2026-10-27T10:22:03.000Z") },
			{ id: "m_3", name: "relay-0000000000000000", state: "hibernated", createdAt: null, deleteAt: null },
		]);
	});
});
