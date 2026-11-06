// `capcomd plugins list` (docs/spec/plugin-api.md §13.2): what GET /v1/plugins says. The running daemon's own listing
// when one is up (it keeps it in state/plugins.json for the CLI, which holds no API token); otherwise what the daemon
// would load, worked out the same way without running any plugin code (discovered, validated, resolved).
// `capcomd plugins validate [<dir>|<name>] [--conformance]` (§4.9, §14): a plugin directory's manifest, or a built-in's
// (all of them with no argument), checked as the host checks it; with --conformance its code is loaded, disposed and
// loaded again (§14.1), and its seams run their conformance suites (§14.2) against the real backend.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError, SCHEMA, EXIT } from "../../core/errors";
import type { PluginSummary } from "../../../packages/plugin/src/host/host";
import type { PluginModule } from "../../../packages/plugin/src/context";
import type { ConformanceResult, SandboxConformanceOptions } from "../../../packages/plugin/src/conformance";
import type { ManifestIssue } from "../../../packages/plugin/src/load";
import type { AgentProvider, SandboxProvider } from "../../../packages/plugin/src/seams";

const USAGE = "usage: capcomd plugins list [--json] | capcomd plugins validate [<dir>|<name>] [--conformance] [--json]";

export async function pluginsCommand(positionals: string[], values: { json?: boolean; conformance?: boolean }): Promise<number> {
  const sub = positionals[1] ?? "list";
  if (sub === "validate") return validateCommand(positionals.slice(2), values);
  if (sub !== "list") throw new RelayError("usage", `unknown plugins command: ${sub}`, USAGE);
  const P = await import("../../plugins/host");
  const snap = P.readSnapshot();
  const plugins: PluginSummary[] = snap ? snap.plugins : P.kernelHost().plan(P.builtinCandidates());
  const daemon = snap ? { pid: snap.pid, at: snap.at } : null;
  if (values.json) {
    console.log(JSON.stringify({ schema: SCHEMA, ok: true, plugins, daemon }));
    return EXIT.ok;
  }
  const where = daemon ? `the running daemon (pid ${daemon.pid})` : "no daemon is running; this is what one would load";
  if (!plugins.length) {
    console.log(`No plugins (${where}).`);
    return EXIT.ok;
  }
  console.log(`Plugins (${where}):`);
  const w = Math.max(...plugins.map((p) => p.name.length));
  for (const p of plugins) {
    const state = p.state === "active" && p.hooksSuspended ? "active, hooks suspended" : p.cause ? `${p.state} (${p.cause})` : p.state;
    const what = [p.hooks.length ? `${p.hooks.length} hook${p.hooks.length > 1 ? "s" : ""}` : "", ...p.seams.map((s) => `${s.kind} ${s.name}`)].filter(Boolean).join(", ");
    console.log(`  ${p.name.padEnd(w)}  ${p.version}  ${p.source}  ${state}${what ? `  ${what}` : ""}${p.stats.failures ? `  ${p.stats.failures}/${p.stats.calls} calls failed` : ""}`);
  }
  return EXIT.ok;
}

/** One plugin's validation, as `--json` prints it. */
interface Validated { name: string; version: string | null; source: "builtin" | "dir"; path: string | null; ok: boolean; issues: ManifestIssue[]; warnings: ManifestIssue[]; conformance: ConformanceResult[] }
type Target = { label: string; dir: string | null; manifest: unknown; module: PluginModule<never> | null; conformance?: SandboxConformanceOptions; kernelSurface?: boolean };

async function validateCommand(args: string[], values: { json?: boolean; conformance?: boolean }): Promise<number> {
  const { BUILTINS } = await import("../../plugins/builtins");
  const builtin = (b: (typeof BUILTINS)[number]): Target => ({ label: String((b.manifest as { name?: unknown }).name), dir: null, manifest: b.manifest, module: b.module, conformance: (b as { conformance?: SandboxConformanceOptions }).conformance ?? {}, kernelSurface: !!b.kernelSurface });
  let targets: Target[];
  if (!args.length) targets = BUILTINS.map(builtin);
  else targets = args.map((a) => {
    if (existsSync(join(a, "plugin.json"))) return { label: a, dir: resolve(a), manifest: null, module: null };
    const b = BUILTINS.find((x) => (x.manifest as { name?: unknown }).name === a);
    if (b) return builtin(b);
    throw new RelayError("not_found", `no plugin directory or built-in plugin named ${a}`, "Pass a directory holding a plugin.json, or a built-in's name (capcomd plugins list).");
  });
  const out: Validated[] = [];
  for (const t of targets) out.push(await validateOne(t, !!values.conformance));
  const ok = out.every((v) => v.ok);
  if (values.json) {
    console.log(JSON.stringify({ schema: SCHEMA, ok, plugins: out }));
    return ok ? EXIT.ok : EXIT.run_failed;
  }
  for (const v of out) {
    console.log(`${v.ok ? "✓" : "✗"} ${v.name}${v.version ? ` ${v.version}` : ""} (${v.source === "builtin" ? "built-in" : v.path})`);
    for (const i of v.issues) console.log(`    ✗ ${i.path}: ${i.message}`);
    for (const i of v.warnings) console.log(`    ! ${i.path}: ${i.message}`);
    for (const c of v.conformance) console.log(`    ${c.skipped ? "-" : c.ok ? "✓" : "✗"} ${c.name}${c.skipped ? ` (skipped: ${c.message})` : c.ok ? ` (${c.ms} ms)` : `: ${c.message}`}`);
  }
  return ok ? EXIT.ok : EXIT.run_failed;
}

async function validateOne(t: Target, conformance: boolean): Promise<Validated> {
  const { loadManifest, readManifest } = await import("../../../packages/plugin/src/load");
  const { VERSION } = await import("../../utils/self");
  const loaded = t.dir ? readManifest(t.dir, { capcomd: VERSION }) : loadManifest(t.manifest, { capcomd: VERSION, kernelSurface: !!t.kernelSurface });
  const m = loaded.manifest;
  const v: Validated = { name: m?.name ?? t.label, version: m?.version ?? null, source: t.dir ? "dir" : "builtin", path: t.dir, ok: loaded.ok, issues: loaded.ok ? [] : loaded.issues, warnings: loaded.ok ? loaded.warnings : [], conformance: [] };
  if (!loaded.ok || !conformance) return v;
  const manifest = loaded.manifest;
  const result = (name: string, r: Partial<ConformanceResult>) => v.conformance.push({ name, ok: false, skipped: false, ms: 0, message: null, ...r });
  if (manifest.entry.runtime !== "in-process") {
    result("conformance", { ok: true, skipped: true, message: "out-of-process plugins are run with the process runtime (spec §17.2 step 9)" });
    return v;
  }
  let mod = t.module as PluginModule<unknown> | null;
  if (!mod && t.dir) {
    try { mod = ((await import(join(t.dir, manifest.entry.module))) as { plugin?: PluginModule<unknown> }).plugin ?? null; } catch (e) {
      result("the entry module imports", { message: (e as Error).message });
      v.ok = false;
      return v;
    }
    if (!mod) { result("the entry module exports `plugin` (§4.3)", { message: `${manifest.entry.module} has no named export \`plugin\`` }); v.ok = false; return v; }
  }
  const { testkit } = await import("../../../packages/plugin/src/testkit");
  const { runSandboxConformance } = await import("../../../packages/plugin/src/conformance");
  const t0 = Date.now();
  try { await testkit.loadDispose(manifest, mod!); result("load, dispose and load again (§14.1)", { ok: true, ms: Date.now() - t0 }); } catch (e) {
    result("load, dispose and load again (§14.1)", { ms: Date.now() - t0, message: (e as Error).message });
  }
  const { runAgentConformance } = await import("../../../packages/plugin/src/agent-conformance");
  for (const s of manifest.contributes?.seams ?? []) {
    if (s.kind === "forge") { result(`the ${s.kind} seam's conformance suite`, { ok: true, skipped: true, message: "the forge suite lands with forges as plugins" }); continue; }
    const fake = testkit.fakeContext(manifest, undefined, t.dir ? { dir: t.dir } : {});
    try {
      await testkit.load(fake, mod!);
      const seam = fake.seam(s.kind);
      if (!seam) { result(`the ${s.kind} seam ${s.name} is registered`, { message: `activate registered no ${s.kind} seam` }); continue; }
      // The agent suite runs no CLI (its methods are pure): the recorded streams it replays are the plugin's own tests'.
      if (s.kind === "agent") v.conformance.push(...runAgentConformance(seam as AgentProvider, { name: s.name }));
      else v.conformance.push(...(await runSandboxConformance(seam as SandboxProvider, { name: s.name, ...(t.conformance ?? {}) })));
    } catch (e) {
      result(`the ${s.kind} seam ${s.name} loads`, { message: (e as Error).message });
    } finally { await fake.dispose(); }
  }
  v.ok = v.conformance.every((c) => c.ok);
  return v;
}
