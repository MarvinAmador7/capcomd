// `capcomd doctor`: boot a VM from the env snapshot (or image) and report, per agent, the CLI
// version, how the credential appears in the VM (bxds_ placeholder vs plain vs absent), and whether
// the API accepts it through boxd's substitution (GET /v1/models from inside the VM).
import type { SandboxProvider } from "../providers/sandbox";
import type { AgentConfig } from "../agents/config";
import { egressFor, type EgressAuth, type RealAgent } from "../agents/config";
import { ALL_ADAPTERS } from "../agents/adapters";
import { agentHome, agentPath, detectScript, parseDetect, SECRET_PLACEHOLDER_PREFIX } from "../agents/runner";
import { Redactor } from "../agents/redact";

export interface DoctorAgent {
  agent: string;
  cli: { ok: boolean; version?: string; bin?: string };
  credential: { mode: "placeholder" | "plain" | "absent" | "subscription"; via: "secret" | "env" | "none" | "subscription" };
  /** Snapshot this agent's VM booted from. */
  from?: string;
  /** hint: an egress-denied diagnosis when the failure looks like a blocked host. */
  api: { ok: boolean; status?: number; detail: string; hint?: string };
  ok: boolean;
}
export interface DoctorReport { vm: string; fromSnapshot?: string; bootMs: number; agents: DoctorAgent[] }
type Mode = "subscription" | "api";

export interface DoctorOptions {
  cfg: AgentConfig;
  snapshot?: string;
  /** Local keys for the env-injection fallback check (never printed). */
  source?: Record<string, string | undefined>;
  curlBin?: string;
  now?: () => number;
  /** Per agent: "subscription" checks the plan login (auth profile snapshot) instead of API keys. */
  modes?: Partial<Record<string, Mode>>;
  /** Snapshot per agent for subscription mode (auth profile). */
  snapshots?: Partial<Record<string, string>>;
}

const API: Record<string, { url: string; header: (v: string) => string[] }> = {
  ANTHROPIC_API_KEY: { url: "https://api.anthropic.com/v1/models", header: () => ["-H", 'x-api-key: $K', "-H", "anthropic-version: 2023-06-01"] },
  OPENAI_API_KEY: { url: "https://api.openai.com/v1/models", header: () => ["-H", "Authorization: Bearer $K"] },
};

export async function doctor(p: SandboxProvider, o: DoctorOptions): Promise<DoctorReport> {
  const groups = new Map<string, string[]>();
  for (const a of ALL_ADAPTERS) {
    const snap = (o.modes?.[a.kind] === "subscription" ? o.snapshots?.[a.kind] : undefined) ?? o.snapshot ?? "";
    groups.set(snap, [...(groups.get(snap) ?? []), a.kind]);
  }
  let first: DoctorReport | undefined;
  const agents: DoctorAgent[] = [];
  for (const [snap, kinds] of groups) {
    const rep = await doctorOne(p, { ...o, snapshot: snap || undefined }, kinds);
    first ??= rep;
    agents.push(...rep.agents);
  }
  return { ...first!, agents: ALL_ADAPTERS.map((a) => agents.find((x) => x.agent === a.kind)!).filter(Boolean) };
}

async function doctorOne(p: SandboxProvider, o: DoctorOptions, kinds: string[]): Promise<DoctorReport> {
  const now = o.now ?? Date.now;
  const src = o.source ?? process.env;
  const r = new Redactor(ALL_ADAPTERS.map((a) => src[a.secretName]));
  const t0 = now();
  // Each agent's provider+auth egress set (subscription codex needs chatgpt.com, auth.openai.com, …).
  const authOf = (k: string): EgressAuth => (o.modes?.[k] === "subscription" ? "subscription" : "apikey");
  const egress = [...new Set(ALL_ADAPTERS.filter((a) => kinds.includes(a.kind)).flatMap((a) => egressFor(a.kind as RealAgent, authOf(a.kind))))];
  const idemKey = `capcomd-doctor-${t0}`;
  // capcomd's own job: recorded so the place's Machines list doesn't show it as left behind.
  const { recordJobMachine } = await import("../providers/machines");
  const { sandboxName } = await import("../providers/registry");
  let place: string | null = null;
  try { place = sandboxName(src); } catch { /* unknown: recorded as such */ }
  const release = recordJobMachine({ idemKey, sandbox: place, kind: "doctor", purpose: "doctor", ttlSeconds: 900 });
  let id: string;
  try { ({ id } = await p.ensure({ idemKey, isolated: true, ttlSeconds: 900, egressAllow: egress, labels: { purpose: "doctor" }, ...(o.snapshot ? { fromSnapshot: o.snapshot } : {}) })); } catch (e) { release(); throw e; }
  const home = agentHome(o.cfg);
  const baseEnv = { PATH: agentPath(home), HOME: home };
  try {
    await p.waitReady(id, 120_000);
    const bootMs = now() - t0;
    const agents: DoctorAgent[] = [];
    for (const a of ALL_ADAPTERS.filter((x) => kinds.includes(x.kind))) {
      if (o.modes?.[a.kind] === "subscription") {
        const det = parseDetect((await p.exec(id, ["sh", "-c", detectScript(a)], { env: baseEnv })).stdout);
        const bin = o.cfg.agentBin ?? det.bin;
        const cli = { ok: !!bin, version: det.version, bin };
        const { verifyLogin } = await import("../auth/login");
        const v = bin ? await verifyLogin(p as any, id, a, o.cfg, bin) : { ok: false, detail: "cli missing" };
        const hint = v.ok ? undefined : egressHint(v.detail, egress, a.kind, "subscription");
        agents.push({ agent: a.kind, cli, credential: { mode: "subscription", via: "subscription" }, api: { ok: v.ok, detail: v.detail, ...(hint ? { hint } : {}) }, ok: cli.ok && v.ok, from: o.snapshot });
        continue;
      }
      const det = parseDetect((await p.exec(id, ["sh", "-c", detectScript(a)], { env: baseEnv })).stdout);
      const inVm = (await p.exec(id, ["sh", "-c", `printenv ${a.secretName} 2>/dev/null; true`], { env: baseEnv })).stdout.trim();
      const mode: DoctorAgent["credential"]["mode"] = !inVm ? "absent" : inVm.startsWith(SECRET_PLACEHOLDER_PREFIX) ? "placeholder" : "plain";
      let via: DoctorAgent["credential"]["via"] = mode === "placeholder" ? "secret" : "none";
      let value = mode === "placeholder" ? inVm : "";
      if (!value && src[a.secretName]?.trim()) { value = src[a.secretName]!.trim(); via = "env"; }
      let api: DoctorAgent["api"] = { ok: false, detail: "no credential (run `capcomd secrets sync` or set it locally)" };
      if (value) {
        const spec = API[a.secretName]!;
        // The key/placeholder is passed via env K and expanded by sh in the VM; never on argv.
        const cmd = `${o.curlBin ?? "curl"} -sS -o /dev/null -m 20 -w '%{http_code}' ${spec.header(value).map((x) => (x.startsWith("-") ? x : `"${x}"`)).join(" ")} ${spec.url}`;
        const res = await p.exec(id, ["sh", "-c", cmd], { env: { ...baseEnv, K: value }, timeoutMs: 30_000 });
        const status = Number(res.stdout.trim().slice(-3));
        api = status === 200 ? { ok: true, status, detail: `GET /v1/models 200 via ${via === "secret" ? "host-bound secret" : "env injection"}` }
          : { ok: false, status: status || undefined, detail: status ? `HTTP ${status}${status === 401 ? " (key rejected or not substituted)" : ""}` : `request failed: ${r.text(res.stderr).slice(-200)}` };
      }
      const cli = { ok: !!det.bin, version: det.version, bin: det.bin };
      if (!api.ok) { const hint = egressHint(api.detail, egress, a.kind, "apikey"); if (hint) api = { ...api, hint }; }
      agents.push({ agent: a.kind, cli, credential: { mode, via }, api, ok: cli.ok && api.ok, from: o.snapshot });
    }
    return { vm: id, fromSnapshot: o.snapshot, bootMs, agents };
  } finally {
    await p.destroy(id).catch(() => {});
    release();
  }
}

export function formatDoctor(rep: DoctorReport): string {
  const lines = [`doctor: vm from ${rep.fromSnapshot ?? "default image"} (boot ${rep.bootMs}ms)`];
  for (const a of rep.agents) {
    lines.push(`  ${a.ok ? "ok  " : "FAIL"} ${a.agent.padEnd(12)} cli=${a.cli.ok ? `${a.cli.version ?? "?"}` : "missing"}  ${a.credential.mode === "subscription" ? `auth=subscription (${a.from ?? "image"})` : `key-in-vm=${a.credential.mode}`}  ${a.credential.mode === "subscription" ? "check" : "api"}=${a.api.detail}`);
    if (a.api.hint) lines.push(`       hint: ${a.api.hint}`);
  }
  return lines.join("\n");
}

/**
 * Diagnose an egress block from a failure text: the host a request failed for (codex: "error
 * sending request for url https://host/…", curl: "Could not resolve host: host", "Failed to
 * connect to host"), checked against the VM's allowlist.
 */
export function egressHint(detail: string, allow: string[], kind: string, auth: string): string | undefined {
  const t = detail ?? "";
  const host =
    /error sending request for url \(?https?:\/\/([^/\s)'"]+)/i.exec(t)?.[1] ??
    /Could not resolve host:?\s*([A-Za-z0-9.-]+)/i.exec(t)?.[1] ??
    /Failed to connect to ([A-Za-z0-9.-]+)/i.exec(t)?.[1] ??
    /(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\s+([A-Za-z0-9.-]+)/i.exec(t)?.[1];
  if (!host) return /failed to refresh (available )?models|egress|connection (refused|reset)|network is unreachable/i.test(t)
    ? `looks like a network/egress block for ${kind} (${auth}); VM allowlist: ${allow.join(", ")}` : undefined;
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const allowed = allow.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) : h === a.toLowerCase()));
  return allowed
    ? `request to ${h} failed although it is on the egress allowlist; check boxd egress/DNS or the provider's status`
    : `egress denied: ${h} is not on the VM allowlist for ${kind} (${auth}). Add it to PROVIDER_EGRESS in src/agents/config.ts, or for one profile set \`egress\` / CAPCOMD_AGENT_EGRESS.`;
}
