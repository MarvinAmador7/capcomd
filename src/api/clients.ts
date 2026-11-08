// Scoped client tokens for harness.v1 (docs/harness-architecture.md §6.3). Tokens are shown once at creation; only their
// sha256 is stored, in ~/.capcomd/harness-clients.json (mode 0600). Scopes: read (GET), steer (start runs: POST /v1/runs;
// pause/resume/cancel runs; send messages), approve (decisions), configure (change settings: PATCH
// /v1/sandboxes/{name}/settings; set a folder up as a project: POST /v1/projects; start and publish its repository:
// POST /v1/projects/git-init and /v1/projects/publish; send a run's proposals to a company's brain in the caller's
// name: POST /v1/runs/{runId}/brain-proposals/send).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capcomdHome } from "../utils/home";

export const CLIENT_SCOPES = ["read", "steer", "approve", "configure"] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];
/** `app`: made by `capcomd clients pair --app <app>` (the next pairing of that app revokes it). */
export type ClientRecord = { id: string; name: string; scopes: ClientScope[]; sha256: string; createdAt: string; revokedAt: string | null; app?: string; plugin?: string };
/** `plugin`: the token was minted for that plugin's process (plugin API §9.3), which its protocol routes require. */
export type AuthedClient = { clientId: string; name: string; scopes: ClientScope[]; plugin?: string };

export const clientsPath = (env: Record<string, string | undefined> = process.env) => join(capcomdHome(env), "harness-clients.json");
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export function loadClients(path = clientsPath()): ClientRecord[] {
	if (!existsSync(path)) return [];
	try { return (JSON.parse(readFileSync(path, "utf8")).clients ?? []) as ClientRecord[]; } catch { return []; }
}
function save(path: string, clients: ClientRecord[]) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ clients }, null, 2), { mode: 0o600 });
	renameSync(tmp, path);
	chmodSync(path, 0o600);
}

function mint(name: string, scopes: ClientScope[], app?: string): { client: ClientRecord; token: string } {
	for (const s of scopes) if (!CLIENT_SCOPES.includes(s)) throw new Error(`unknown scope ${s} (use ${CLIENT_SCOPES.join(", ")})`);
	const id = `cli-${randomBytes(6).toString("hex")}`;
	const token = `cch_${randomBytes(32).toString("base64url")}`;
	const client: ClientRecord = { id, name, scopes: [...new Set(scopes)], sha256: hash(token), createdAt: new Date().toISOString(), revokedAt: null, ...(app ? { app } : {}) };
	return { client, token };
}

/** Create a client; returns the token once. */
export function addClient(name: string, scopes: ClientScope[], path = clientsPath()): { client: ClientRecord; token: string } {
	const made = mint(name, scopes);
	save(path, [...loadClients(path), made.client]);
	return made;
}

/** What an app gets when it pairs: everything the capcomd app does (read, start and steer runs, approve, settings). */
export const APP_SCOPES: ClientScope[] = ["read", "steer", "approve", "configure"];
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `capcomd clients pair --app <app>`: a token for an app on this computer. The app runs the command as the local user
 * (being able to write the clients file is what lets it) and keeps the token itself, so nobody copies or pastes it. An
 * app holds one token: those that earlier pairings of the same app made are revoked (`clients add` tokens are left alone).
 */
export function pairClient(app: string, scopes: ClientScope[] = APP_SCOPES, path = clientsPath()): { client: ClientRecord; token: string; revoked: string[] } {
	if (!APP_NAME.test(app)) throw new Error(`app name ${JSON.stringify(app)}: use letters, digits, ".", "_" or "-" (up to 64)`);
	const made = mint(app, scopes, app);
	const all = loadClients(path);
	const now = new Date().toISOString();
	const revoked: string[] = [];
	for (const c of all) if (c.app === app && !c.revokedAt) { c.revokedAt = now; revoked.push(c.id); }
	save(path, [...all, made.client]);
	return { ...made, revoked };
}

/**
 * A token for one call of the CLI to the daemon (src/cli/daemon.ts): the CLI holds none, so it makes one with the scopes
 * the call needs, as `pairClient` does (writing the clients file is what lets it), and `remove()` deletes the record once
 * the call is answered, so it neither works nor stays listed after.
 */
export function oneCallClient(name: string, scopes: ClientScope[], path = clientsPath()): { client: ClientRecord; token: string; remove(): void } {
	const made = mint(name, scopes);
	save(path, [...loadClients(path), made.client]);
	return { ...made, remove: () => save(path, loadClients(path).filter((c) => c.id !== made.client.id)) };
}

export function revokeClient(id: string, path = clientsPath()): boolean {
	const all = loadClients(path);
	const c = all.find((x) => x.id === id && !x.revokedAt);
	if (!c) return false;
	c.revokedAt = new Date().toISOString();
	save(path, all);
	return true;
}

/** Bearer token → client, or null. Compares hashes in constant time; revoked clients never match. */
export function authenticate(header: string | null | undefined, clients: ClientRecord[]): AuthedClient | null {
	const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
	if (!m) return null;
	const h = Buffer.from(hash(m[1]!), "hex");
	for (const c of clients) {
		if (c.revokedAt) continue;
		const ch = Buffer.from(c.sha256, "hex");
		if (ch.length === h.length && timingSafeEqual(ch, h)) return { clientId: c.id, name: c.name, scopes: c.scopes, ...(c.plugin ? { plugin: c.plugin } : {}) };
	}
	return null;
}

/**
 * Out-of-process plugins' tokens (plugin API §9.3): minted like `addClient`'s, named `plugin:<name>` with the manifest's
 * scopes and marked with the plugin, one per start of its process. They live in this daemon's memory only, never in
 * harness-clients.json: revoking one deletes it, and a daemon that dies leaves none behind that still works.
 */
const pluginTokens = new Map<string, ClientRecord>();

export function mintPluginClient(plugin: string, scopes: readonly string[]): { client: ClientRecord; token: string; revoke(): void } {
	const made = mint(`plugin:${plugin}`, scopes.filter((s): s is ClientScope => s !== "approve" && (CLIENT_SCOPES as readonly string[]).includes(s)));
	const client: ClientRecord = { ...made.client, id: `plg-${randomBytes(6).toString("hex")}`, plugin };
	pluginTokens.set(client.id, client);
	return { client, token: made.token, revoke: () => { pluginTokens.delete(client.id); } };
}

/** The plugin tokens that work now (the gateway authenticates against these beside the file's clients). */
export const pluginClients = (): ClientRecord[] => [...pluginTokens.values()];
