// Running inside a boxd machine (an agent like Hermes on boxd): the machine's metadata service mints short-lived org
// credentials, which the boxd SDK uses when it is given no key (`new Boxd()`), so capcomd needs no BOXD_API_KEY there.
// Only machines that aren't isolated get them: every agent VM capcomd starts is isolated, and the service answers
// those "VM is isolated" (403), checked live on 2026-10-24. The env vars are only a hint (isolated machines have them
// too): a token coming back is the test. The token itself is never kept here; the SDK mints its own.
import { readFileSync } from "fs";

const HINTS = ["BOXD_VM_ID", "BOXD_VM_NAME", "BOXD_PROXY_ENDPOINT"];
const METADATA_PORT = 9002;

export interface BoxdMachine {
  /** In a boxd machine (its env says so). */
  inside: boolean;
  /** Its metadata service hands out org credentials (the machine isn't isolated). */
  credentials: boolean;
  name?: string;
  detail: string;
}

/** The default route's gateway from /proc/net/route, where the metadata service listens. */
function gateway(read: (p: string) => string): string | null {
  let table: string;
  try { table = read("/proc/net/route"); } catch { return null; }
  for (const line of table.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== "00000000") continue;
    const ip = Number.parseInt(f[2]!, 16);
    return Number.isFinite(ip) ? [ip & 0xff, (ip >> 8) & 0xff, (ip >> 16) & 0xff, (ip >>> 24) & 0xff].join(".") : null;
  }
  return null;
}

let cached: Promise<BoxdMachine> | null = null;
/** Whether this process runs in a boxd machine whose credentials it can use (asked once per process). */
export function boxdMachine(source: Record<string, string | undefined> = process.env, deps: { fetch?: typeof fetch; read?: (p: string) => string } = {}): Promise<BoxdMachine> {
  const fresh = deps.fetch !== undefined || deps.read !== undefined || source !== process.env;
  if (cached && !fresh) return cached;
  const p = (async (): Promise<BoxdMachine> => {
    const name = source.BOXD_VM_NAME || source.BOXD_VM_ID || undefined;
    if (!HINTS.some((h) => source[h])) return { inside: false, credentials: false, detail: "not in a boxd machine" };
    const gw = gateway(deps.read ?? ((f) => readFileSync(f, "utf8")));
    if (!gw) return { inside: true, credentials: false, ...(name ? { name } : {}), detail: "in a boxd machine, but its metadata service can't be found (no default route)" };
    try {
      const r = await (deps.fetch ?? fetch)(`http://${gw}:${METADATA_PORT}/v1/auth/token`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j: any = await r.json().catch(() => null);
        if (typeof j?.token === "string") return { inside: true, credentials: true, ...(name ? { name } : {}), detail: `inside boxd machine ${name ?? "(unnamed)"}: using its credentials` };
        return { inside: true, credentials: false, ...(name ? { name } : {}), detail: "in a boxd machine, but its metadata service gave no token" };
      }
      const why = (await r.text().catch(() => "")).trim().slice(0, 100);
      return { inside: true, credentials: false, ...(name ? { name } : {}), detail: `in a boxd machine whose metadata service gives no credentials (${r.status}${why ? `: ${why}` : ""})` };
    } catch {
      return { inside: true, credentials: false, ...(name ? { name } : {}), detail: "in a boxd machine, but its metadata service didn't answer" };
    }
  })();
  if (!fresh) cached = p;
  return p;
}
