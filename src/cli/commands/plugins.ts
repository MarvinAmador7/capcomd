// `capcomd plugins list` (docs/spec/plugin-api.md §13.2): what GET /v1/plugins says. The running daemon's own listing
// when one is up (it keeps it in state/plugins.json for the CLI, which holds no API token); otherwise what the daemon
// would load, worked out the same way without running any plugin code (discovered, validated, resolved).
import { RelayError, SCHEMA, EXIT } from "../../core/errors";
import type { PluginSummary } from "../../../packages/plugin/src/host/host";

export async function pluginsCommand(positionals: string[], values: { json?: boolean }): Promise<number> {
  const sub = positionals[1] ?? "list";
  if (sub !== "list") throw new RelayError("usage", `unknown plugins command: ${sub}`, "usage: capcomd plugins list [--json]");
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
