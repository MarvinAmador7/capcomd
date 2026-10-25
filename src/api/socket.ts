// harness.v1 transport: a 0600 Unix socket (docs/harness-architecture.md §6.3 option A).
// Path precedence: --harness-socket flag > CAPCOMD_HARNESS_SOCKET > config `harness.socket` > ~/.capcomd/harness.sock.
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { capcomdHome } from "../utils/home";
import type { CapcomdConfig } from "../config/store";

export function harnessSocketPath(o: { flag?: string; env?: Record<string, string | undefined>; config?: CapcomdConfig } = {}): string {
	const env = o.env ?? process.env;
	const p = o.flag || env.CAPCOMD_HARNESS_SOCKET || o.config?.harness?.socket;
	return p ? resolve(p.replace(/^~(?=\/)/, process.env.HOME ?? "~")) : join(capcomdHome(env), "harness.sock");
}

/**
 * Serve `fetch` on a Unix socket, mode 0600. The Host header is ignored on the socket: clients send `Host: localhost`
 * (recommended) or anything else, e.g. AsyncHTTPClient's hex-encoded socket path. Auth is the socket mode plus the token.
 */
export function serveHarnessSocket(path: string, fetch: (req: Request) => Response | Promise<Response>) {
	const dir = dirname(path);
	const fresh = !existsSync(dir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (fresh) chmodSync(dir, 0o700);
	if (existsSync(path)) unlinkSync(path);
	const server = Bun.serve({ unix: path, fetch });
	chmodSync(path, 0o600);
	return server;
}
