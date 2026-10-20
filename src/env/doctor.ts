// `capcomd doctor`: boot a VM from the env snapshot (or image) and report, per agent, the CLI
// version, how the credential appears in the VM (bxds_ placeholder vs plain vs absent), and whether
// the API accepts it through boxd's substitution (GET /v1/models from inside the VM).
import type { SandboxProvider } from "../providers/sandbox";
import type { AgentConfig } from "../agents/config";
import { BASE_EGRESS } from "../agents/config";
import { ALL_ADAPTERS } from "../agents/adapters";
import { agentHome, agentPath, detectScript, parseDetect, SECRET_PLACEHOLDER_PREFIX } from "../agents/runner";
import { Redactor } from "../agents/redact";

export interface DoctorAgent {
  agent: string;
  cli: { ok: boolean; version?: string; bin?: string };
  credential: { mode: "placeholder" | "plain" | "absent" | "subscription"; via: "secret" | "env" | "none" | "subscription" };
  /** Snapshot this agent's VM booted from. */
  from?: string;
  api: { ok: boolean; status?: number; detail: string };
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
  const egress = [...BASE_EGRESS, ...ALL_ADAPTERS.map((a) => a.apiHost)];
  const { id } = await p.ensure({ idemKey: `capcomd-doctor-${t0}`, isolated: true, ttlSeconds: 900, egressAllow: egress, labels: { purpose: "doctor" }, ...(o.snapshot ? { fromSnapshot: o.snapshot } : {}) });
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
        agents.push({ agent: a.kind, cli, credential: { mode: "subscription", via: "subscription" }, api: { ok: v.ok, detail: v.detail }, ok: cli.ok && v.ok, from: o.snapshot });
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
      agents.push({ agent: a.kind, cli, credential: { mode, via }, api, ok: cli.ok && api.ok, from: o.snapshot });
    }
    return { vm: id, fromSnapshot: o.snapshot, bootMs, agents };
  } finally {
    await p.destroy(id).catch(() => {});
  }
}

export function formatDoctor(rep: DoctorReport): string {
  const lines = [`doctor: vm from ${rep.fromSnapshot ?? "default image"} (boot ${rep.bootMs}ms)`];
  for (const a of rep.agents) {
    lines.push(`  ${a.ok ? "ok  " : "FAIL"} ${a.agent.padEnd(12)} cli=${a.cli.ok ? `${a.cli.version ?? "?"}` : "missing"}  ${a.credential.mode === "subscription" ? `auth=subscription (${a.from ?? "image"})` : `key-in-vm=${a.credential.mode}`}  ${a.credential.mode === "subscription" ? "check" : "api"}=${a.api.detail}`);
  }
  return lines.join("\n");
}
