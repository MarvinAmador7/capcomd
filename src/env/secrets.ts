// `capcomd secrets sync`: push local API keys into boxd host-bound secrets (scope private).
// The VM then only ever sees a bxds_ placeholder; boxd substitutes the real value on egress to the
// bound host. Values are read from the local env and never printed, logged or returned.
import type { EnvPlatform, SecretInfo } from "./platform";
import { ALL_ADAPTERS } from "../agents/adapters";

export interface SyncLine { name: string; domains: string[]; status: "set" | "skipped" | "verify_failed" | "unavailable"; detail: string }

export async function secretsSync(p: EnvPlatform, source: Record<string, string | undefined> = process.env, only?: string[]): Promise<SyncLine[]> {
  const out: SyncLine[] = [];
  for (const a of ALL_ADAPTERS) {
    if (only?.length && !only.includes(a.kind)) continue;
    const value = source[a.secretName]?.trim();
    const domains = [a.apiHost];
    if (!value) { out.push({ name: a.secretName, domains, status: "skipped", detail: "not set in local env" }); continue; }
    try {
      await p.secretSet(a.secretName, value, { domains, scope: "private" });
      out.push({ name: a.secretName, domains, status: "set", detail: "stored (private, host-bound)" });
    } catch (e) {
      // Optional feature: org-scoped boxd keys cannot use secrets.* (needs a member credential).
      const msg = String((e as Error)?.message ?? e).split(value).join("[REDACTED]");
      out.push({ name: a.secretName, domains, status: "unavailable", detail: `boxd secrets unavailable (${unavailableReason(msg)}); skipped` });
    }
  }
  if (!out.some((l) => l.status === "set")) return out;
  let listed: SecretInfo[] = [];
  try { listed = await p.secretList(); } catch (e) {
    for (const l of out) if (l.status === "set") { l.status = "verify_failed"; l.detail = `secrets.list failed: ${unavailableReason(String((e as Error)?.message))}`; }
    return out;
  }
  for (const line of out) {
    if (line.status !== "set") continue;
    const s = listed.find((x) => x.name === line.name);
    if (!s) { line.status = "verify_failed"; line.detail = "not returned by secrets.list"; continue; }
    const same = [...s.domains].sort().join(",") === [...line.domains].sort().join(",");
    if (!same) { line.status = "verify_failed"; line.detail = `bound to ${s.domains.join(",") || "(none)"}, expected ${line.domains.join(",")}`; }
    else line.detail = `stored (scope ${s.scope || "private"}, bound to ${s.domains.join(",")})`;
  }
  return out;
}

export function unavailableReason(msg: string): string {
  if (/member|permission|denied|forbidden|org.?scoped|unauth/i.test(msg)) return "this boxd key cannot use secrets; org-scoped keys need a member credential";
  return msg.replace(/\s+/g, " ").slice(0, 160);
}
