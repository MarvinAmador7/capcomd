// front-setup's commands (src/plugins/front/groups.ts): setting capcomd up, its service, updates, API clients, the
// web UI. Moved as they were from src/cli/index.ts's `switch` (plugin API §17.2 step 8).
import { EXIT } from "../../core/errors";
import { ui } from "../commands/ui";
import { type Cmd, type KernelCommand, usage, out } from "./common";

/** `capcomd clients` */
async function clientsCommand({ positionals, values, json }: Cmd): Promise<number> {
  const C = await import("../../api/clients");
  const [, sub, arg] = positionals;
  if (sub === "add" && arg) {
    const scopes = String(values.scopes ?? "read").split(",").map((x) => x.trim()).filter(Boolean) as import("../../api/clients").ClientScope[];
    const { client, token } = C.addClient(arg, scopes);
    console.log(JSON.stringify({ id: client.id, name: client.name, scopes: client.scopes, token, note: "shown once; store it in the client" }, null, 2));
    return EXIT.ok;
  }
  if (sub === "list") { console.log(JSON.stringify(C.loadClients().map(({ sha256: _h, ...c }) => c), null, 2)); return EXIT.ok; }
  if (sub === "revoke" && arg) { if (!C.revokeClient(arg)) usage(`no active client ${arg}`); console.log(JSON.stringify({ revoked: arg })); return EXIT.ok; }
  if (sub === "pair") {
    // The app reads stdout: the token alone (with --json, the object). Nothing writes it anywhere else.
    const app = (values.app as string | undefined) ?? usage("usage: capcomd clients pair --app <name> [--scopes read,steer,approve,configure] [--json]");
    const scopes = values.scopes === undefined ? undefined : String(values.scopes).split(",").map((x) => x.trim()).filter(Boolean) as import("../../api/clients").ClientScope[];
    let r: ReturnType<typeof C.pairClient>;
    try { r = C.pairClient(app, scopes); } catch (e) { usage(e instanceof Error ? e.message : String(e)); }
    if (json) out({ id: r.client.id, name: r.client.name, app, scopes: r.client.scopes, token: r.token, revoked: r.revoked, version: (await import("../../utils/self")).VERSION });
    else process.stdout.write(`${r.token}\n`);
    return EXIT.ok;
  }
  usage("capcomd clients add <name> [--scopes read,steer,approve,configure] | pair --app <name> | list | revoke <id>");
  return EXIT.usage;
}

/** `capcomd ui` */
async function uiCommand(_c: Cmd): Promise<number> {
  await ui();
  return EXIT.ok;
}

/** `capcomd setup` */
async function setupCommand({ positionals, values, json }: Cmd): Promise<number> {
  const S = await import("../commands/setup");
  const part = positionals[1];
  if (part === "check") {
    const steps = await S.checkSetup();
    if (json) out({ steps, ok: steps.every((s) => s.ok) }); else console.log(`capcomd setup check\n${S.formatSteps(steps)}`);
    return steps.every((s) => s.ok) ? EXIT.ok : EXIT.run_failed;
  }
  if (part && !["all", "demo", "accounts", "project", "agent", "service"].includes(part)) usage("usage: capcomd setup [demo|accounts|project|agent|service|check] [--yes] [flags]");
  const v = { ...values, ...(values.agents === undefined ? {} : { agents: values.agents }) } as Record<string, unknown>;
  const steps = await S.setup(part, v, json ? () => {} : (l) => console.log(l));
  const ok = steps.every((s) => s.ok);
  if (json) out({ steps, ok });
  else console.log(`\n${S.formatSteps(steps)}\n${ok ? "\nReady. Next: `capcomd setup check` any time; README Quickstart step 4 to run agents." : "\nSome steps need attention (see → above). Re-run `capcomd setup` (finished steps are skipped or kept)."}`);
  return ok ? EXIT.ok : EXIT.run_failed;
}

/** `capcomd update` (alias `capcomd upgrade`) */
async function updateCommand({ values, json }: Cmd): Promise<number> {
  const U = await import("../commands/upgrade");
  const r = await U.upgrade({ to: values.to as string | undefined, dryRun: !!values["dry-run"], restart: !values["no-restart"], json });
  const e = r.engine;
  const engineFailed = !!e && !r.dryRun && (e.detail !== undefined || (e.restarted && !e.running));
  if (json) { out(r as unknown as Record<string, unknown>); return engineFailed ? EXIT.run_failed : EXIT.ok; }
  const say = (s: string) => console.log(s);
  if (r.how) {
    if (r.kind === "checkout") say(`capcomd ${r.current} runs from a development checkout; update it with: ${r.how}`);
    else say(`capcomd ${r.latest} is available (this is ${r.current}), but ${r.reason}; update it with: ${r.how}`);
    return EXIT.ok;
  }
  if (r.dryRun) {
    const change = r.latest ? `capcomd ${r.current} → ${r.latest}` : `capcomd ${r.current}`;
    const restart = e?.wouldRestart ? ", then restart the engine service" : "";
    say(`${change}: would run \`${r.command}\`${restart} (dry run: nothing was changed)`);
    return EXIT.ok;
  }
  if (!r.upgraded) { say(`capcomd ${r.current} is up to date`); return EXIT.ok; }
  say(`✓ capcomd ${r.current} → ${r.latest}${r.path ? ` (${r.path})` : r.command ? ` (${r.command})` : ""}`);
  if (r.pruned?.length) say(`  removed the engines of ${r.pruned.join(", ")}`);
  if (e?.restarted) say(e.running ? `✓ engine service restarted${e.version ? `; ${e.version} is running` : ""}${e.version && e.version !== r.latest ? ` (the service runs another capcomd install)` : ""}` : `✗ engine service restarted, but it isn't answering on :${e.port}`);
  else if (e?.detail) say(`✗ couldn't restart the engine service: ${e.detail}`);
  if (e?.hint) say(`  ${e.hint}`);
  return engineFailed ? EXIT.run_failed : EXIT.ok;
}

/** `capcomd service` */
async function serviceCommand({ positionals, values, json }: Cmd): Promise<number> {
  const S = await import("../commands/service");
  const sub = positionals[1] ?? "status";
  const port = parseInt(values.port as string, 10);
  if (sub === "install") {
    const r: any = await S.serviceInstall({ port, dryRun: !!values["dry-run"], atLogin: !values["no-login"] });
    if (json) out(r);
    else if (r.dryRun) console.log(`would write ${r.path}:\n\n${r.body}`);
    else console.log(`✓ engine service installed (${r.path}${r.atLogin ? "" : ", not started at login"}); ${r.running ? `running on :${r.port}` : `not answering on :${r.port} yet; see ${r.log}`}`);
    return r.dryRun || r.running ? EXIT.ok : EXIT.run_failed;
  }
  if (sub === "uninstall") { const r = S.serviceUninstall(); if (json) out(r); else console.log(r.uninstalled ? `✓ removed ${r.path}` : "no engine service was installed"); return EXIT.ok; }
  if (sub === "status") {
    const r = await S.serviceStatus({ port });
    if (json) out(r); else console.log(`service: ${r.installed ? (r.loaded ? "installed, loaded" : "installed, not loaded") : "not installed"}; engine on :${r.port}: ${r.running ? "running" : "not running"}  (log: ${r.log})`);
    return EXIT.ok;
  }
  usage("usage: capcomd service install|uninstall|status [--port N] [--dry-run] [--no-login]");
  return EXIT.usage;
}

export const COMMANDS: Record<string, KernelCommand> = {
  "clients": clientsCommand,
  "ui": uiCommand,
  "setup": setupCommand,
  "update": updateCommand,
  "upgrade": updateCommand,
  "service": serviceCommand,
};
