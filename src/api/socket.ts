// harness.v1 transport: a 0600 Unix socket (docs/harness-architecture.md §6.3 option A).
// Path precedence: --harness-socket flag > CAPCOMD_HARNESS_SOCKET > config `harness.socket` > ~/.capcomd/harness.sock.
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { capcomdHome } from "../utils/home";
import type { CapcomdConfig } from "../config/store";

export function harnessSocketPath(o: { flag?: string; env?: Record<string, string | undefined>; config?: CapcomdConfig } = {}): string {
	const env = o.env ?? process.env;
	const p = o.flag || env.CAPCOMD_HARNESS_SOCKET || o.config?.harness?.socket;
	return p ? resolve(p.replace(/^~(?=\/)/, process.env.HOME ?? "~")) : join(capcomdHome(env), "harness.sock");
}

/**
 * What sits at a socket path: nothing; a stale file (a dead daemon's socket, or not a socket at all) that may be
 * replaced; or something that is listening. `version` is set when a harness.v1 daemon answered `GET /v1/health`.
 */
export type HarnessSocketState =
	| { state: "absent" }
	| { state: "stale"; reason: string; ino: number; dev: number }
	| { state: "live"; version?: string; detail: string };

const fileId = (path: string) => { try { const s = lstatSync(path); return { ino: s.ino, dev: s.dev, socket: s.isSocket() }; } catch { return null; } };

export async function probeHarnessSocket(path: string, timeoutMs = 2000): Promise<HarnessSocketState> {
	const id = fileId(path);
	if (!id) return { state: "absent" };
	if (!id.socket) return { state: "stale", reason: "not a socket", ino: id.ino, dev: id.dev };
	try {
		const r = await fetch("http://localhost/v1/health", { unix: path, signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
		const j = (await r.json().catch(() => null)) as { api?: string; version?: string } | null;
		if (j?.api === "harness.v1") return { state: "live", ...(j.version ? { version: j.version } : {}), detail: "a harness.v1 daemon answered" };
		return { state: "live", detail: `another server answered (HTTP ${r.status})` };
	} catch (e) {
		const code = (e as { code?: string }).code;
		// Nobody listens: a daemon that died without cleaning up. Only this (or not a socket) counts as stale.
		if (code === "ECONNREFUSED" || code === "ENOTSOCK") return { state: "stale", reason: code === "ENOTSOCK" ? "not a socket" : "connection refused", ino: id.ino, dev: id.dev };
		if (code === "ENOENT") return { state: "absent" };
		// A timeout (something accepts but never answers), a permission error, …: someone may still be using it.
		return { state: "live", detail: `it did not answer GET /v1/health (${code ?? (e as Error).name ?? "error"})` };
	}
}

/** A live harness (or something else) already listens on the socket: refuse to start rather than steal it. */
export class HarnessSocketInUseError extends Error {
	constructor(readonly path: string, readonly version: string | undefined, detail: string) {
		super(
			`${version ? `a capcomd daemon (version ${version})` : "something"} is already serving ${path} (${detail}); not replacing it. ` +
			"Stop that daemon first, or give this one its own socket with --harness-socket PATH or CAPCOMD_HARNESS_SOCKET=PATH.",
		);
		this.name = "HarnessSocketInUseError";
	}
}

/** Refuse when a live server holds `path`; remove a stale socket (only the very file that was probed). */
async function claim(path: string): Promise<void> {
	const s = await probeHarnessSocket(path);
	if (s.state === "live") throw new HarnessSocketInUseError(path, s.version, s.detail);
	if (s.state === "stale") {
		const now = fileId(path);
		if (now && now.ino === s.ino && now.dev === s.dev) { try { unlinkSync(path); } catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; } }
	}
}

export interface HarnessSocket {
	server: ReturnType<typeof Bun.serve>;
	path: string;
	/** True while `path` is still the socket this process bound (same inode and device). */
	owned(): boolean;
	/** Remove `path` if it is still ours (sync: safe in an `exit` handler). Never deletes another daemon's socket. */
	release(): void;
	/** Stop serving and release(). */
	close(): void;
}

/**
 * Serve `fetch` on a Unix socket, mode 0600. The Host header is ignored on the socket: clients send `Host: localhost`
 * (recommended) or anything else, e.g. AsyncHTTPClient's hex-encoded socket path. Auth is the socket mode plus the token.
 *
 * Never takes over a live socket: if a server answers on `path` this throws HarnessSocketInUseError and leaves the file
 * alone; only a stale one (connection refused, or not a socket) is replaced. The socket is bound under a private name in
 * the same directory and hard-linked into place, which fails if another daemon got there first (then we probe again).
 * Bun unlinks the bound name on stop, so it never deletes whatever later sits at `path`; release() does that, and
 * only when the file there is still ours.
 */
export async function serveHarnessSocket(path: string, fetch: (req: Request) => Response | Promise<Response>): Promise<HarnessSocket> {
	const dir = dirname(path);
	const fresh = !existsSync(dir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (fresh) chmodSync(dir, 0o700);
	for (let attempt = 0; ; attempt++) {
		await claim(path);
		const tmp = join(dir, `.hs-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
		// Create the socket already 0600: no window where another local user could connect. chmod stays as belt-and-braces.
		const prev = process.umask(0o177);
		let server: ReturnType<typeof Bun.serve>;
		// idleTimeout above the SSE heartbeat (HEARTBEAT_MS, 15 s): Bun's default 10 s cut every quiet event stream. Bun
		// honours it on a unix socket (checked: a stream lasts past 25 s with it, 12 s without), but its types only declare
		// it for TCP servers, hence the untyped spread; server.timeout(req, 0) does not help there.
		const idle: object = { idleTimeout: 60 };
		try { server = Bun.serve({ unix: tmp, fetch, ...idle }); } finally { process.umask(prev); }
		try {
			chmodSync(tmp, 0o600);
			linkSync(tmp, path);
		} catch (e) {
			server.stop(true);
			// Another daemon bound `path` between our probe and now: probe it again (and refuse if it's live).
			if ((e as { code?: string }).code === "EEXIST" && attempt < 3) continue;
			throw e;
		} finally {
			try { unlinkSync(tmp); } catch {}
		}
		const id = fileId(path)!;
		const owned = () => { const now = fileId(path); return !!now && now.ino === id.ino && now.dev === id.dev; };
		const release = () => { if (owned()) { try { unlinkSync(path); } catch {} } };
		return { server, path, owned, release, close: () => { server.stop(true); release(); } };
	}
}
