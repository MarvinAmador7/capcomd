// `capcomd plugins list` (docs/spec/plugin-api.md §13.2): what GET /v1/plugins says. The running daemon's own listing
// when one is up (it keeps it in state/plugins.json for the CLI, which holds no API token); otherwise what the daemon
// would load, worked out the same way without running any plugin code (discovered, validated, resolved).
// `capcomd plugins show <name>`: one plugin as GET /v1/plugins/{name} has it, with where it was installed from.
// `capcomd plugins validate [<dir>|<name>] [--conformance]` (§4.9, §14): a plugin directory's manifest, or a built-in's
// (all of them with no argument), checked as the host checks it; with --conformance its code is loaded, disposed and
// loaded again (§14.1), and its seams run their conformance suites (§14.2) against the real backend.
// `capcomd plugins install|update|remove|trust|allow-version` (§4.4, §4.8, §17.2 step 12): src/plugins/install.ts. They
// change files the daemon reads at its next start or a plugin's `enable`.
// `capcomd plugins enable|disable <name>` (§5.4, §6.5, §10.2): `plugins.<name>.enabled` in the user's config, and the
// running daemon's POST /v1/plugins/{name}/enable|disable (src/cli/daemon.ts), so it acts now and lasts.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError, SCHEMA, EXIT } from "../../core/errors";
import type { PluginSummary } from "../../../packages/plugin/src/host/host";
import type { PluginModule } from "../../../packages/plugin/src/context";
import type { ConformanceResult, SandboxConformanceOptions } from "../../../packages/plugin/src/conformance";
import type { ManifestIssue } from "../../../packages/plugin/src/load";
import type { AgentProvider, SandboxProvider } from "../../../packages/plugin/src/seams";

const USAGE = [
  "usage: capcomd plugins list [--json]",
  "       capcomd plugins show <name> [--json]",
  "       capcomd plugins validate [<dir>|<name>] [--conformance] [--json]",
  "       capcomd plugins install <owner/repo>[#<name>][@<ref>] [--project] [--json]   (a git URL or a local repository path works too)",
  "       capcomd plugins install --project [--json]   (the project's plugins.use)",
  "       capcomd plugins update <name> [--project] [--dry-run] [--json]",
  "       capcomd plugins remove <name> [--project] [--json]",
  "       capcomd plugins trust [<name>] [--yes] [--json]",
  "       capcomd plugins allow-version <name>@<version> --accept-risk [--json]",
  "       capcomd plugins enable <name> [--json]",
  "       capcomd plugins disable <name> [--json]",
].join("\n");

type Values = { json?: boolean; conformance?: boolean; project?: boolean; yes?: boolean; acceptRisk?: boolean; dryRun?: boolean };
const out = (body: Record<string, unknown>) => console.log(JSON.stringify({ schema: SCHEMA, ok: true, ...body }));
const short = (sha: string) => sha.slice(0, 12);
/** A manifest's text as the trust prompt prints it: control and format characters (escape sequences, carriage returns,
 *  bidi overrides) shown as `\u{…}`, so a plugin can't redraw or hide what the operator is asked about. */
const visible = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

export async function pluginsCommand(positionals: string[], values: Values): Promise<number> {
  const sub = positionals[1] ?? "list";
  const args = positionals.slice(2);
  if (sub === "validate") return validateCommand(args, values);
  if (sub === "install") return installCommand(args, values);
  if (sub === "update") return updateCommand(args, values);
  if (sub === "remove") return removeCommand(args, values);
  if (sub === "trust") return trustCommand(args, values);
  if (sub === "allow-version") return allowVersionCommand(args, values);
  if (sub === "show") return showCommand(args, values);
  if (sub === "enable" || sub === "disable") return toggleCommand(sub, args, values);
  if (sub !== "list") throw new RelayError("usage", `unknown plugins command: ${sub}`, USAGE);
  const P = await import("../../plugins/host");
  const snap = P.readSnapshot();
  const plugins: PluginSummary[] = snap ? snap.plugins : P.kernelHost({ log: false }).plan(P.builtinCandidates());
  const daemon = snap ? { pid: snap.pid, at: snap.at } : null;
  const installs = await installedFacts(plugins);
  if (values.json) {
    out({ plugins, daemon, installs });
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
    const i = installs[p.name];
    const note = i?.modified ? "  files changed since it was installed (capcomd plugins update replaces them)" : i?.trust === "changed" ? "  changed since you trusted it (capcomd plugins trust)" : p.cause === "untrusted" ? `  not trusted yet (capcomd plugins trust ${p.name})` : "";
    console.log(`  ${p.name.padEnd(w)}  ${p.version}  ${p.source}  ${state}${what ? `  ${what}` : ""}${p.stats.failures ? `  ${p.stats.failures}/${p.stats.calls} calls failed` : ""}${note}`);
  }
  return EXIT.ok;
}

/** For each third-party plugin listed: where it was installed from (its LOCK), whether its files changed since, and for
 *  a project's whether the operator trusts it as it is now. */
async function installedFacts(plugins: PluginSummary[]): Promise<Record<string, { source: string | null; commit: string | null; modified: boolean; trust?: "trusted" | "changed" | "untrusted" }>> {
  const I = await import("../../plugins/install");
  const { lockState } = await import("../../install/lock");
  const facts: Record<string, { source: string | null; commit: string | null; modified: boolean; trust?: "trusted" | "changed" | "untrusted" }> = {};
  for (const p of plugins.filter((x) => x.source === "user")) {
    const s = lockState(join(I.userPluginsDir(), p.name));
    facts[p.name] = { source: s?.lock.source ?? null, commit: s?.lock.commit ?? null, modified: !!s && "modified" in s && s.modified };
  }
  const project = I.projectOf();
  if (project) for (const x of I.projectPluginList(project)) {
    if (!plugins.some((p) => p.name === x.name && p.source === "project")) continue;
    const s = lockState(x.dir);
    facts[x.name] = { source: s?.lock.source ?? null, commit: s?.lock.commit ?? null, modified: !!s && "modified" in s && s.modified, trust: x.trust };
  }
  return facts;
}

/** The project of the working directory, for --project and trust; a usage error outside one. */
async function project(): Promise<string> {
  const p = (await import("../../plugins/install")).projectOf();
  if (!p) throw new RelayError("usage", "not in a project: no .capcomd/config.json here or above", "Run it in the project's checkout (capcomd setup project makes one).");
  return p;
}

async function installCommand(args: string[], values: Values): Promise<number> {
  const I = await import("../../plugins/install");
  if (!args.length) {
    if (!values.project) throw new RelayError("usage", "install needs a source", USAGE);
    const dir = await project();
    const results = await I.installProjectUses(dir);
    if (values.json) { out({ project: dir, results }); return results.some((r) => "error" in r) ? EXIT.run_failed : EXIT.ok; }
    if (!results.length) console.log("The project lists no plugins to fetch (plugins.use in .capcomd/config.json).");
    for (const r of results) {
      if ("error" in r) console.log(`✗ ${r.source}: ${r.error}`);
      else if ("present" in r) console.log(`  ${r.source}: ${r.present} is already fetched`);
      else console.log(`✓ ${r.name} ${r.version} from ${r.source} (commit ${short(r.commit)}). It runs once you trust it: capcomd plugins trust ${r.name}`);
    }
    return results.some((r) => "error" in r) ? EXIT.run_failed : EXIT.ok;
  }
  if (args.length > 1) throw new RelayError("usage", "install takes one source", USAGE);
  const r = await I.installPlugin(args[0]!, { project: values.project ? await project() : null });
  if (values.json) { out({ installed: r }); return EXIT.ok; }
  console.log(`Installed ${r.name} ${r.version} from ${r.source} (commit ${short(r.commit)}, ${r.hash}) in ${r.dir}.`);
  console.log(r.project
    ? `It is one of this project's plugins (plugins.use): it runs once you trust it, capcomd plugins trust ${r.name}.`
    : "The daemon runs it from its next start (capcomd service restart), or when it is enabled again.");
  return EXIT.ok;
}

async function updateCommand(args: string[], values: Values): Promise<number> {
  const name = args[0];
  if (!name || args.length > 1) throw new RelayError("usage", "update takes a plugin's name", USAGE);
  const I = await import("../../plugins/install");
  const u = await I.updatePlugin(name, { project: values.project ? await project() : null, dryRun: !!values.dryRun });
  if (values.json) { out({ update: u }); return EXIT.ok; }
  const same = u.from.hash === u.to.hash && !u.modified;
  if (same) {
    console.log(`${name} is up to date (${u.to.version}, ${u.to.hash})${u.updated ? `; its LOCK now names commit ${short(u.to.commit)}` : ""}.`);
    return EXIT.ok;
  }
  console.log(`${name}: ${u.from.version ?? "?"} → ${u.to.version}, commit ${short(u.from.commit)} → ${short(u.to.commit)}`);
  console.log(`  hash ${u.from.hash}\n    → ${u.to.hash}`);
  for (const [k, list] of [["changed", u.changed], ["added", u.added], ["removed", u.removed]] as const) if (list.length) console.log(`  ${k}: ${list.join(", ")}`);
  if (u.modified) console.log(`  edited since it was installed (replaced by the update): ${[...u.modified.changed, ...u.modified.added, ...u.modified.removed].join(", ")}`);
  if (!u.updated) { console.log("Nothing was changed (--dry-run)."); return EXIT.ok; }
  console.log(values.project ? `Updated. Its content changed, so it waits for your trust again: capcomd plugins trust ${name}` : "Updated. The daemon runs the new version from its next start, or when the plugin is enabled again.");
  return EXIT.ok;
}

async function removeCommand(args: string[], values: Values): Promise<number> {
  const name = args[0];
  if (!name || args.length > 1) throw new RelayError("usage", "remove takes a plugin's name", USAGE);
  const r = (await import("../../plugins/install")).removePlugin(name, { project: values.project ? await project() : null });
  if (values.json) { out({ removed: r }); return EXIT.ok; }
  console.log(`Removed ${name} (${r.dir}). Its data stays in capcomd's state; a running daemon stops it at its next start.`);
  return EXIT.ok;
}

/**
 * `capcomd plugins trust [<name>]` (§4.8): the trust prompt. It shows what would run on this machine (the command, the
 * scopes its token gets, the hooks it answers, the files and their hash) and asks; --yes trusts without asking. With no
 * name, the project's plugins and whether each is trusted.
 */
async function trustCommand(args: string[], values: Values): Promise<number> {
  const I = await import("../../plugins/install");
  const dir = await project();
  const list = I.projectPluginList(dir);
  if (!args.length) {
    if (values.json) { out({ project: dir, plugins: list.map(({ manifest, ...p }) => ({ ...p, version: manifest?.version ?? null })) }); return EXIT.ok; }
    if (!list.length) { console.log("This project has no plugins (.capcomd/plugins/<name>/, or plugins.use fetched with capcomd plugins install --project)."); return EXIT.ok; }
    for (const p of list) console.log(`  ${p.name}  ${p.manifest?.version ?? "?"}  ${p.trust}${p.trust === "changed" ? " (its content changed since you trusted it)" : ""}  ${p.dir}`);
    return EXIT.ok;
  }
  const name = args[0]!;
  const p = list.find((x) => x.name === name);
  if (!p) throw new RelayError("not_found", `this project has no plugin ${name}`, "capcomd plugins trust lists them.");
  if (!p.hash || !p.manifest) throw new RelayError("config", `${name} can't be trusted: ${p.issues.join("; ")}`, "Fix the plugin's files first (capcomd plugins validate <dir>).");
  if (p.trust === "trusted") {
    if (values.json) out({ trusted: { name, hash: p.hash, dir: p.dir, already: true } }); else console.log(`${name} is trusted as it is (${p.hash}).`);
    return EXIT.ok;
  }
  const m = p.manifest;
  if (!values.json) {
    console.log(`${name} ${m.version}: ${visible(m.description)}`);
    console.log(`  from     ${visible(p.dir)}${p.from === "use" ? " (plugins.use)" : ""}`);
    if (m.entry.runtime === "process") console.log(`  runs     ${m.entry.command.map((a) => /^[\w./${}=:@%+,-]+$/.test(a) ? a : visible(JSON.stringify(a))).join(" ")}  (on this machine, as you, out of process)`);
    console.log(`  scopes   ${(m.scopes ?? []).join(", ") || "none"}`);
    console.log(`  hooks    ${Object.keys(m.contributes?.hooks ?? {}).join(", ") || "none"}`);
    // Its secrets reach it at its start (§10.3): a manifest's default reference names a variable of yours.
    const { secretKeys } = await import("../../../packages/plugin/src/host/host");
    const { secretRef } = await import("../../plugins/secrets");
    const refs = secretKeys(m, p.dir).map((k) => { try { return `${k} ← ${visible(secretRef(m, k, process.env, p.dir))}`; } catch { return `${k} (none set)`; } });
    console.log(`  secrets  ${refs.join(", ") || "none"}`);
    console.log(`  hash     ${p.hash}`);
    if (p.trust === "changed") console.log(`  You trusted other content before (${p.trustedHash}): its files changed since.`);
  }
  if (!values.yes) {
    const ask = (await import("../prompt")).prompter();
    if (!ask.interactive) throw new RelayError("usage", `trusting ${name} needs your confirmation`, `Run it in a terminal, or pass --yes to trust ${p.hash}.`);
    if (!(await ask.confirm(`Run ${name} with this content for this project?`, false))) { console.log("Not trusted."); return EXIT.run_failed; }
  }
  I.trustPlugin(name, { project: dir, hash: p.hash });
  if (values.json) { out({ trusted: { name, hash: p.hash, dir: p.dir, already: false } }); return EXIT.ok; }
  console.log(`Trusted ${name} (${p.hash}). The daemon runs it from its next start, or when it is enabled again; a changed file needs trusting again.`);
  return EXIT.ok;
}

async function allowVersionCommand(args: string[], values: Values): Promise<number> {
  if (args.length !== 1) throw new RelayError("usage", "allow-version takes <name>@<version>", USAGE);
  const e = (await import("../../plugins/install")).allowVersion(args[0]!, { acceptRisk: !!values.acceptRisk });
  if (values.json) { out({ allowed: e }); return EXIT.ok; }
  console.log(`${e.name}@${e.version} may run on this capcomd although its engines range leaves it out (that version only).`);
  return EXIT.ok;
}

/**
 * `capcomd plugins enable|disable <name>` (§5.4, §6.5, §10.2). It records `plugins.<name>.enabled` in the user's config,
 * which the daemon reads at each start, and asks the running daemon, if one runs, to act now: `enable` starts a
 * disabled, disposed or failed plugin again and resets an active one's breaker, `disable` stops it. A built-in can't be
 * disabled (the kernel runs on its places, agents, forges and front doors), except one a person turns on (the watchdog).
 */
async function toggleCommand(action: "enable" | "disable", args: string[], values: Values): Promise<number> {
  const name = args[0];
  if (!name || args.length > 1) throw new RelayError("usage", `${action} takes a plugin's name`, USAGE);
  const P = await import("../../plugins/host");
  const { OPT_IN } = await import("../../plugins/builtins");
  // A plugin the daemon runs (its project's too) or would load from here.
  const p = [...(P.readSnapshot()?.plugins ?? []), ...P.kernelHost({ log: false }).plan(P.builtinCandidates())].find((x) => x.name === name);
  if (!p) throw new RelayError("not_found", `no plugin ${name}`, "capcomd plugins list names them.");
  if (action === "disable" && p.source === "builtin" && !OPT_IN.has(name)) {
    throw new RelayError("conflict", `${name} is built into capcomd: it can't be disabled`, "The kernel runs on its built-in places, agents, forges and front doors. A setting of the plugin's may turn off what you don't want (capcomd plugins show " + name + ").");
  }
  const on = action === "enable";
  const { userConfigPath, writeConfig } = await import("../../config/store");
  const path = userConfigPath();
  writeConfig(path, { plugins: { [name]: { enabled: on } } });
  const { envName } = await import("../../plugins/config");
  const env = process.env[envName(name, "enabled")];
  const notes = [
    ...(process.env.CAPCOMD_NO_CONFIG ? ["CAPCOMD_NO_CONFIG is set here: a daemon started with it doesn't read your config."] : []),
    ...(env !== undefined && env !== "" ? [`${envName(name, "enabled")}=${env} in the environment wins over your config where it is set.`] : []),
  ];
  const { callDaemon } = await import("../daemon");
  const call = await callDaemon("POST", `/v1/plugins/${encodeURIComponent(name)}/${action}`, { scope: "configure" });
  // The daemon refused it (not that it doesn't have the plugin, or couldn't be reached): the config holds it anyway.
  if (call.kind === "answered" && call.status !== 200 && call.status !== 404) {
    throw new RelayError(call.status === 409 ? "conflict" : "run_failed", `the running daemon (pid ${call.pid}) didn't ${action} ${name}: ${String(call.body.message ?? `HTTP ${call.status}`)}`,
      `Your config says plugins.${name}.enabled = ${on} (${path}): the daemon applies it at its next start (capcomd service restart).`);
  }
  const daemon = call.kind === "none" ? null
    : call.kind === "unreachable" ? { pid: call.pid, applied: false as const, reason: call.reason }
    : call.status === 200 ? { pid: call.pid, applied: true as const, plugin: call.body as unknown as PluginSummary }
    : { pid: call.pid, applied: false as const, reason: `it has no plugin ${name} (it serves another project)` };
  if (values.json) {
    out({ plugin: name, enabled: on, config: path, daemon, notes });
    return EXIT.ok;
  }
  console.log(`${on ? "Enabled" : "Disabled"} ${name} in your config (${path}: plugins.${name}.enabled = ${on}).`);
  if (!daemon) console.log("No daemon is running: the config is all that changed, and a daemon applies it when it starts.");
  else if (daemon.applied) {
    const s = daemon.plugin;
    console.log(`The running daemon (pid ${daemon.pid}) ${on ? "enabled" : "disabled"} it: ${s.state}${s.cause ? ` (${s.cause})` : ""}.${on && s.state === "failed" ? ` capcomd plugins show ${name} says why.` : ""}`);
  } else console.log(`The running daemon (pid ${daemon.pid}) didn't ${action} it: ${daemon.reason}. A daemon applies your config when it starts (capcomd service restart).`);
  for (const n of notes) console.log(`  ${n}`);
  return EXIT.ok;
}

async function showCommand(args: string[], values: Values): Promise<number> {
  const name = args[0];
  if (!name || args.length > 1) throw new RelayError("usage", "show takes a plugin's name", USAGE);
  const P = await import("../../plugins/host");
  const host = P.kernelHost({ log: false });
  host.plan(P.builtinCandidates());
  const d = host.detail(name);
  if (!d) throw new RelayError("not_found", `no plugin ${name}`, "capcomd plugins list names them.");
  const live = P.readSnapshot()?.plugins.find((p) => p.name === name) ?? null;
  const facts = (await installedFacts([d]))[name] ?? null;
  const plugin = { ...d, ...(live ? { state: live.state, cause: live.cause, stats: live.stats, hooksSuspended: live.hooksSuspended } : {}) };
  if (values.json) { out({ plugin, installed: facts, message: host.message(name) }); return EXIT.ok; }
  console.log(`${d.name} ${d.version}  ${d.source}  ${plugin.state}${plugin.cause ? ` (${plugin.cause})` : ""}${live ? "" : "  (no daemon is running: what one would do)"}`);
  if (d.manifest) console.log(`  ${d.manifest.description}`);
  const why = host.message(name);
  if (why && plugin.cause) console.log(`  why: ${why}`);
  if (facts?.source) console.log(`  installed from ${facts.source} (commit ${facts.commit ? short(facts.commit) : "?"})${facts.modified ? "; files changed since" : ""}`);
  if (facts?.trust) console.log(`  trust: ${facts.trust}`);
  for (const [k, v] of Object.entries(d.config.values)) console.log(`  config ${k} = ${JSON.stringify(v)}  (${d.config.sources[k] ?? "default"})`);
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
    result("conformance", { ok: true, skipped: true, message: "an out-of-process plugin is checked by its own tests (the client library and test kit, spec §9.8, §14.5)" });
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
    if (s.kind === "forge") { result(`the ${s.kind} seam's conformance suite`, { ok: true, skipped: true, message: "the forge suite runs in capcomd's own tests, against local repositories (tests/plugins/forges.test.ts)" }); continue; }
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
  // ADR-025 §3.1: each context provider's suite; the cases that read items need a fixture repository, so they're skipped.
  const { runContextConformance } = await import("../../../packages/plugin/src/context-conformance");
  for (const c of manifest.contributes?.context ?? []) {
    const fake = testkit.fakeContext(manifest, undefined, t.dir ? { dir: t.dir } : {});
    try {
      await testkit.load(fake, mod!);
      const p = fake.contextProvider(c.name);
      if (!p) { result(`the context provider ${c.name} is registered`, { message: "activate registered no context provider of that name" }); continue; }
      v.conformance.push(...(await runContextConformance(p, { name: c.name })));
    } catch (e) {
      result(`the context provider ${c.name} loads`, { message: (e as Error).message });
    } finally { await fake.dispose(); }
  }
  v.ok = v.conformance.every((c) => c.ok);
  return v;
}
