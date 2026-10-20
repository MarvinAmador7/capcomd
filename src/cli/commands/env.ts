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
    const ok = lines.every((l) => l.status !== "verify_failed") && lines.some((l) => l.status === "set");
    emit(json, { ok, secrets: lines }, lines.map((l) => `  ${l.status.padEnd(13)} ${l.name.padEnd(18)} → ${l.domains.join(",")}  ${l.detail}`).join("\n"));
    return ok ? 0 : 1;
  }
  if (command === "doctor") {
    const p = providerFromEnv();
    const snapshot = resolveEnvSnapshot();
    const rep = await doctor(p, { cfg: loadAgentConfig(), snapshot });
    const ok = rep.agents.some((a) => a.ok);
    emit(json, { ok, ...rep }, formatDoctor(rep));
    return ok ? 0 : 1;
  }
  const sub = pos[1];
  if (sub === "build") {
    const repo = loadMergeConfig();
    if (!repo) throw new RelayError("config", "env build needs CAPCOMD_REPO (the repo whose deps to bake in)", "export CAPCOMD_REPO=owner/name");
    const res = await envBuild(platform(), { repoUrl: repo.remote, cfg: loadAgentConfig(), force: !!values.force, log, forbidden: ALL_ADAPTERS.map((a) => process.env[a.secretName]).filter(Boolean) as string[] });
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
