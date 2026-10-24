// Preflight for real sandboxes: validate credentials with cheap calls before creating anything.
// Messages never include key material.
import { BOXD_AUTH_HINT, isBoxdAuthError } from "../providers/boxd-errors";
import { Redactor } from "../agents/redact";
import { realSandbox } from "../providers/registry";

export interface PreflightCheck { name: string; ok: boolean; detail: string }

export interface PreflightDeps {
  /** Cheap authenticated boxd call (default: machines.list via @boxd-sh/sdk). */
  boxdList?: (apiKey: string) => Promise<unknown>;
  fetch?: typeof fetch;
}

/** Credentials are checked before real agents start (a provider that runs them), not for the test fakes. */
export function preflightNeeded(source: Record<string, string | undefined> = process.env): boolean {
  return realSandbox(source) && source.CAPCOMD_SKIP_PREFLIGHT !== "1";
}

async function defaultBoxdList(apiKey: string) {
  const { Boxd } = require("@boxd-sh/sdk") as typeof import("@boxd-sh/sdk");
  const c: any = new Boxd({ apiKey });
  try { return await c.machines.list(); } finally { await c.close?.().catch(() => {}); }
}

export async function runPreflight(source: Record<string, string | undefined> = process.env, deps: PreflightDeps = {}, profile?: string): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  const boxdKey = source.BOXD_API_KEY?.trim();
  const anthKey = source.ANTHROPIC_API_KEY?.trim();
  const r = new Redactor([boxdKey, anthKey, source.BOXD_API_KEY, source.ANTHROPIC_API_KEY]);

  if (!boxdKey) out.push({ name: "boxd", ok: false, detail: "BOXD_API_KEY is not set" });
  else {
    try {
      await (deps.boxdList ?? defaultBoxdList)(boxdKey);
      out.push({ name: "boxd", ok: true, detail: "BOXD_API_KEY accepted (machines.list)" });
    } catch (err) {
      out.push({ name: "boxd", ok: false, detail: isBoxdAuthError(err)
        ? `BOXD_API_KEY was rejected by boxd (invalid or expired). ${BOXD_AUTH_HINT}`
        : `boxd unreachable: ${r.text((err as Error)?.message ?? String(err)).slice(0, 300)}` });
    }
  }

  const { credentialModeFor } = require("../agents/config") as typeof import("../agents/config");
  const { profileFor } = require("../auth/profiles") as typeof import("../auth/profiles");
  const { resolveAgent } = require("../agents/profiles") as typeof import("../agents/profiles");
  let agent: string = "fake";
  let credMode: string = "auto";
  try {
    const ra = resolveAgent(profile, source);
    agent = ra.kind;
    if (agent !== "fake") credMode = credentialModeFor(ra.kind, source, ra.spec?.auth);
  } catch (e) {
    // Bad profile file, unknown profile, or both/neither credentials configured.
    out.push({ name: "agent", ok: false, detail: r.text((e as Error).message) });
    return out.map((c) => ({ ...c, detail: r.text(c.detail) }));
  }
  const spec = agent === "claude-code"
    ? { name: "anthropic", env: "ANTHROPIC_API_KEY", label: "Anthropic", url: "https://api.anthropic.com/v1/models?limit=1", headers: (k: string) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }) }
    : agent === "codex"
      ? { name: "openai", env: "OPENAI_API_KEY", label: "OpenAI", url: "https://api.openai.com/v1/models", headers: (k: string) => ({ Authorization: `Bearer ${k}` }) }
      : null;
  if (spec && credMode === "subscription") {
    // Plan login: no API key needed. The login itself is checked by `capcomd auth status` / doctor.
    const prof = profileFor(agent, source);
    out.push(prof
      ? { name: spec.name, ok: true, detail: `subscription login (${prof.method}, ${prof.store === "secret" ? "boxd secret" : prof.snapshot}); no API key needed` }
      : { name: spec.name, ok: false, detail: `CAPCOMD_CREDENTIALS=subscription but no auth profile; run \`capcomd auth login ${agent === "codex" ? "codex" : "claude"}\`` });
  } else if (spec) {
    const key = source[spec.env]?.trim();
    r.add(key);
    if (!key) {
      // With boxd host-bound secrets the key need not exist locally; doctor verifies it inside a VM.
      if (credMode === "secret") out.push({ name: spec.name, ok: true, detail: `${spec.env} not set locally; using the boxd host-bound secret (verify: capcomd doctor)` });
      else out.push({ name: spec.name, ok: false, detail: `${spec.env} is not set (or run \`capcomd secrets sync\` and set CAPCOMD_CREDENTIALS=secret)` });
    } else {
      try {
        const res = await (deps.fetch ?? fetch)(spec.url, { headers: spec.headers(key), signal: AbortSignal.timeout(15_000) });
        if (res.ok) out.push({ name: spec.name, ok: true, detail: `${spec.env} accepted (GET /v1/models)` });
        else if (res.status === 401 || res.status === 403) out.push({ name: spec.name, ok: false, detail: `${spec.env} was rejected (HTTP ${res.status}). Check the key (no quotes or whitespace) and retry.` });
        else { let msg = ""; try { const j: any = await res.json(); msg = `${j?.error?.type ?? j?.error?.code ?? ""}: ${j?.error?.message ?? ""}`.slice(0, 300); } catch {} out.push({ name: spec.name, ok: false, detail: `${spec.label} API returned HTTP ${res.status}${msg ? ` (${msg})` : ""}` }); }
      } catch (err) {
        out.push({ name: spec.name, ok: false, detail: `${spec.label} API unreachable: ${r.text((err as Error)?.message ?? String(err)).slice(0, 300)}` });
      }
    }
  }
  return out.map((c) => ({ ...c, detail: r.text(c.detail) }));
}
