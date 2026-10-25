// Scoped client tokens for harness.v1 (docs/harness-architecture.md §6.3). Tokens are shown once at creation; only their
// sha256 is stored, in ~/.capcomd/harness-clients.json (mode 0600). Scopes: read (GET), steer (reserved for phase 2), approve (decisions).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capcomdHome } from "../utils/home";

export const CLIENT_SCOPES = ["read", "steer", "approve"] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];
export type ClientRecord = { id: string; name: string; scopes: ClientScope[]; sha256: string; createdAt: string; revokedAt: string | null };
export type AuthedClient = { clientId: string; name: string; scopes: ClientScope[] };

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

/** Create a client; returns the token once. */
export function addClient(name: string, scopes: ClientScope[], path = clientsPath()): { client: ClientRecord; token: string } {
	for (const s of scopes) if (!CLIENT_SCOPES.includes(s)) throw new Error(`unknown scope ${s} (use ${CLIENT_SCOPES.join(", ")})`);
	const id = `cli-${randomBytes(6).toString("hex")}`;
	const token = `cch_${randomBytes(32).toString("base64url")}`;
	const client: ClientRecord = { id, name, scopes: [...new Set(scopes)], sha256: hash(token), createdAt: new Date().toISOString(), revokedAt: null };
	save(path, [...loadClients(path), client]);
	return { client, token };
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
		if (ch.length === h.length && timingSafeEqual(ch, h)) return { clientId: c.id, name: c.name, scopes: c.scopes };
	}
	return null;
}
