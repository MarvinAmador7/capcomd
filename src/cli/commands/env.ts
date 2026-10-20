// capcomd env build|status|rm, secrets sync, doctor.
import { providerFromEnv } from "../../dependencies";
import { loadAgentConfig } from "../../agents/config";
import { loadMergeConfig } from "../../merge/config";
import { isEnvPlatform } from "../../env/platform";
import { envBuild, envRm, envStatus } from "../../env/build";
import { secretsSync } from "../../env/secrets";
import { doctor, formatDoctor } from "../../env/doctor";
import { resolveEnvSnapshot } from "../../env/resolve";
import { RelayError, SCHEMA } from "../../core/errors";
import { ALL_ADAPTERS } from "../../agents/adapters";

/** env/auth/doctor work on the CLIs, not one agent's credentials: don't apply the strict auth check. */
const toolCfg = () => loadAgentConfig({ ...process.env, CAPCOMD_CREDENTIALS: "auto", CAPCOMD_AGENT: "fake" });

function platform() {
  const p = providerFromEnv();
  if (!isEnvPlatform(p)) throw new RelayError("config", "this sandbox has no snapshots/secrets; set CAPCOMD_SANDBOX=boxd", "export CAPCOMD_SANDBOX=boxd BOXD_API_KEY=…");
  return p as any;
}
const emit = (json: boolean, obj: Record<string, unknown>, text: string) => console.log(json ? JSON.stringify({ schema: SCHEMA, ok: obj.ok ?? true, ...obj }) : text);

export async function envCommand(command: string, pos: string[], values: Record<string, any>): Promise<number> {
  const json = !!values.json;
  const log = (l: string) => { if (!json) console.error(`[env] ${l}`); };
  if (command === "secrets") {
    if (pos[1] !== "sync") throw new RelayError("usage", "usage: capcomd secrets sync", "");
    const lines = await secretsSync(platform());
    // Optional: never fatal (subscription logins need no API keys; org-scoped boxd keys can't use secrets).
    const ok = lines.every((l) => l.status !== "verify_failed");
    emit(json, { ok, secrets: lines }, lines.map((l) => `  ${l.status.padEnd(13)} ${l.name.padEnd(18)} → ${l.domains.join(",")}  ${l.detail}`).join("\n") || "  nothing to sync");
    return 0;
  }
  if (command === "auth") return authCommand(pos, values);
  if (command === "doctor") {
    const p = providerFromEnv();
    const snapshot = resolveEnvSnapshot();
    const { credentialModeFor } = await import("../../agents/config");
    const { profileFor } = await import("../../auth/profiles");
    const modes: Record<string, "subscription" | "api"> = {}, snapshots: Record<string, string> = {};
    for (const k of ["claude-code", "codex"] as const) {
      let m = "auto"; try { m = credentialModeFor(k); } catch {}
      if (m === "subscription") { modes[k] = "subscription"; const pr = profileFor(k); if (pr?.snapshot) snapshots[k] = pr.snapshot; }
    }
    const rep = await doctor(p, { cfg: toolCfg(), snapshot, modes, snapshots });
    const ok = rep.agents.some((a) => a.ok);
    emit(json, { ok, ...rep }, formatDoctor(rep));
    return ok ? 0 : 1;
  }
  const sub = pos[1];
  if (sub === "build") {
    const repo = loadMergeConfig();
    const res = await envBuild(platform(), { repoUrl: repo?.remote, cfg: toolCfg(), force: !!values.force, log, forbidden: ALL_ADAPTERS.map((a) => process.env[a.secretName]).filter(Boolean) as string[] });
    const v = Object.entries(res.record.versions).map(([k, x]) => `${k}=${x.version}(${x.source})`).join(" ");
    emit(json, { name: res.name, cached: res.cached, record: res.record }, `${res.cached ? "up to date" : "built"}: ${res.name}  ${v}${res.record.buildMs ? `  ${res.record.buildMs}ms` : ""}`);
    return 0;
  }
  if (sub === "status") {
    const st = await envStatus(platform());
    const text = st.snapshots.length ? st.snapshots.map((s) => `${s.current ? "*" : " "} ${s.name}  ${s.status}${s.record ? `  built ${s.record.builtAt}  ${Object.entries(s.record.versions).map(([k, x]) => `${k}=${x.version}`).join(" ")}` : ""}`).join("\n") : "no capcomd env snapshots (run `capcomd env build`)";
    emit(json, st as any, `${text}\nworkers use: ${resolveEnvSnapshot() ?? "default image"}`);
    return 0;
  }
  if (sub === "rm") {
    const removed = await envRm(platform(), pos[2]);
    emit(json, { removed }, `removed: ${removed.join(", ")}`);
    return 0;
  }
  throw new RelayError("usage", "usage: capcomd env build [--force] | env status | env rm [name|all]", "");
}

async function authCommand(pos: string[], values: Record<string, any>): Promise<number> {
  const json = !!values.json;
  const { authLogin, authStatus, authLogout, parseAgentArg } = await import("../../auth/login");
  const sub = pos[1];
  const p = platform();
  const cfg = toolCfg();
  if (sub === "login") {
    const agent = parseAgentArg(pos[2]);
    let envSnapshot = resolveEnvSnapshot();
    if (!envSnapshot) {
      console.error("[auth] no env snapshot yet; building one first");
      envSnapshot = (await envBuild(p, { cfg, log: (l) => console.error(`[env] ${l}`) })).name;
    }
    console.error(`[auth] ${agent === "codex" ? "codex login --device-auth" : "claude setup-token"} in a VM from ${envSnapshot}. Open the URL below in your browser; tokens are never printed.`);
    const store = (process.env.CAPCOMD_AUTH_STORE ?? "auto") as "auto" | "secret" | "snapshot";
    const res = await authLogin(p, agent, { cfg, envSnapshot, store, log: (l) => console.error(`[auth] ${l}`) });
    emit(json, { profile: res.profile, loginMs: res.loginMs, totalMs: res.totalMs }, `logged in: ${agent} → ${res.profile.store === "secret" ? "boxd secret CLAUDE_CODE_OAUTH_TOKEN" : res.profile.snapshot}  (verified, ${(res.totalMs / 1000).toFixed(1)}s)`);
    return 0;
  }
  if (sub === "status") {
    const agents = pos[2] ? [parseAgentArg(pos[2])] : undefined;
    const lines = await authStatus(p, cfg, { verify: !values.quick, agents });
    emit(json, { ok: lines.every((l) => !l.present || l.valid !== false), profiles: lines }, lines.map((l) => `  ${!l.present ? "none " : l.valid === false ? "INVALID" : l.valid ? "valid" : "?    "} ${l.agent.padEnd(12)} ${l.snapshot ?? (l.store === "secret" ? "boxd secret" : "")}  ${l.detail}`).join("\n"));
    return lines.some((l) => l.present && l.valid === false) ? 1 : 0;
  }
  if (sub === "logout") {
    const removed = await authLogout(p, parseAgentArg(pos[2]));
    emit(json, { removed }, removed.length ? `removed: ${removed.join(", ")}` : "no profile");
    return 0;
  }
  throw new RelayError("usage", "usage: capcomd auth login|status|logout claude|codex [--quick]", "");
}
