// Preflight for real sandboxes: validate credentials with cheap calls before creating anything.
// Messages never include key material.
import { env as envVar } from "../utils/env";
import { BOXD_AUTH_HINT, isBoxdAuthError } from "../providers/boxd-errors";
import { Redactor } from "../agents/redact";

export interface PreflightCheck { name: string; ok: boolean; detail: string }

export interface PreflightDeps {
  /** Cheap authenticated boxd call (default: machines.list via @boxd-sh/sdk). */
  boxdList?: (apiKey: string) => Promise<unknown>;
  fetch?: typeof fetch;
}

export function preflightNeeded(source: Record<string, string | undefined> = process.env): boolean {
  return (envVar("SANDBOX", source) ?? "fake").toLowerCase() === "boxd" && source.CAPCOMD_SKIP_PREFLIGHT !== "1";
}

async function defaultBoxdList(apiKey: string) {
  const { Boxd } = require("@boxd-sh/sdk") as typeof import("@boxd-sh/sdk");
  const c: any = new Boxd({ apiKey });
  try { return await c.machines.list(); } finally { await c.close?.().catch(() => {}); }
}

export async function runPreflight(source: Record<string, string | undefined> = process.env, deps: PreflightDeps = {}): Promise<PreflightCheck[]> {
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

  if ((envVar("AGENT", source) ?? "fake").toLowerCase() === "claude-code") {
    if (!anthKey) out.push({ name: "anthropic", ok: false, detail: "ANTHROPIC_API_KEY is not set" });
    else {
      try {
        const res = await (deps.fetch ?? fetch)("https://api.anthropic.com/v1/models?limit=1", {
          headers: { "x-api-key": anthKey, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) out.push({ name: "anthropic", ok: true, detail: "ANTHROPIC_API_KEY accepted (GET /v1/models)" });
        else if (res.status === 401 || res.status === 403) out.push({ name: "anthropic", ok: false, detail: `ANTHROPIC_API_KEY was rejected (HTTP ${res.status}). Check the key (no quotes or whitespace) and retry.` });
        else { let msg = ""; try { const j: any = await res.json(); msg = `${j?.error?.type ?? ""}: ${j?.error?.message ?? ""}`.slice(0, 300); } catch {} out.push({ name: "anthropic", ok: false, detail: `Anthropic API returned HTTP ${res.status}${msg ? ` (${msg})` : ""}` }); }
      } catch (err) {
        out.push({ name: "anthropic", ok: false, detail: `Anthropic API unreachable: ${r.text((err as Error)?.message ?? String(err)).slice(0, 300)}` });
      }
    }
  }
  return out.map((c) => ({ ...c, detail: r.text(c.detail) }));
}
