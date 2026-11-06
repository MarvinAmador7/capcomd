#!/usr/bin/env bash
# Install the packed @capcomd/plugin (scripts/pack.ts) the way a plugin author does, in a fresh project, and use it
# from Node (no Bun): every entry point imports; the manifest checks, the test kit's load/dispose and hook contract run;
# `connect()` speaks the protocol over a Unix socket to a stand-in daemon (node:http); and a TypeScript consumer
# typechecks against the declarations with `moduleResolution: nodenext` (TypeScript 5, @types/node).
#   packages/plugin/scripts/smoke.sh dist/capcomd-plugin-X.Y.Z.tgz
# Ends with `SMOKE PASS` (exit 0) or `SMOKE FAIL: <step>` (exit 1). Needs node and npm, and the npm registry for zod,
# typescript and @types/node.
set -euo pipefail
TGZ=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/capcomd-plugin-smoke.XXXXXX"); trap 'rm -rf "$W"' EXIT
step() { echo "== $1"; CUR=$1; }
trap 'echo "SMOKE FAIL: ${CUR:-setup}"' ERR
cd "$W"
echo "node $(node --version), npm $(npm --version), in $W"

step "npm install the package"
npm init -y > /dev/null
npm pkg set type=module > /dev/null
npm install --no-audit --no-fund --loglevel=error "$TGZ" typescript@5 @types/node > install.log 2>&1 || { cat install.log; false; }
test -f node_modules/@capcomd/plugin/dist/index.js
cp "$HERE/../examples/slack-notifier/plugin.json" "$W/plugin.json"

step "every entry point imports on Node, and works there"
cat > use.mjs <<'EOF'
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_NAMES, PLUGIN_PROTOCOL_VERSION, PluginError, PluginManifest, definePlugin, satisfies, sessionOpen } from "@capcomd/plugin";
import { connect } from "@capcomd/plugin/client";
import { samplePayload, testkit } from "@capcomd/plugin/testkit";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(require.resolve("@capcomd/plugin/package.json"), "utf8"));
const schema = JSON.parse(readFileSync(require.resolve("@capcomd/plugin/schema"), "utf8"));
assert.equal(schema.title, "capcomd plugin manifest (capcomd.plugin/v1)");
assert.ok(HOOK_NAMES.includes("merge.landing"));
assert.equal(satisfies("0.10.0-rc.1", ">=0.9.0 <1.0.0"), true);

// The manifest check, as `capcomd plugins validate` runs it.
const v = await testkit.validateManifest(process.cwd(), { capcomd: pkg.version });
assert.equal(v.ok, true, JSON.stringify(v));

// The test kit on an in-process module: load and dispose twice, the hook contract.
const manifest = PluginManifest.parse({ schema: "capcomd.plugin/v1", name: "smoke", version: "1.0.0", description: "smoke", apiVersion: 1, engines: { capcomd: ">=0.9.0" },
  entry: { runtime: "in-process", module: "./index.js" }, scopes: ["read"], contributes: { hooks: { "merge.landing": {} } } });
const plugin = definePlugin({ activate(ctx) { ctx.hooks.on("merge.landing", () => ({ decision: "allow" })); } });
await testkit.loadDispose(manifest, plugin);
await testkit.hookContract(manifest, plugin);
const fake = testkit.fakeContext(manifest);
await testkit.load(fake, plugin);
assert.deepEqual((await fake.fire("merge.landing", samplePayload("merge.landing"))).result, { decision: "allow" });
await fake.dispose();

// connect() without the daemon's environment refuses; with it, it speaks the protocol over the socket (node:http).
assert.throws(() => connect({}), PluginError);
const dir = mkdtempSync(join(tmpdir(), "cps-"));
writeFileSync(join(dir, "plugin.json"), JSON.stringify({ contributes: { hooks: { "merge.landing": {} } } }));
const seen = [];
const call = { callId: "call_1", hook: "merge.landing", mode: "veto", payloadVersion: 1, idempotencyKey: "k", deadline: new Date(Date.now() + 10_000).toISOString(),
  trace: { traceId: "0".repeat(32), spanId: "0".repeat(16) }, principal: { kind: "operator", clientId: null }, runId: "run-1", agentId: null, at: new Date().toISOString(), payload: samplePayload("merge.landing") };
const daemon = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (req.url.endsWith("/sessions")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ session: "ses_1", protocol: 1, config: {}, secrets: {} })); return; }
    if (req.url.includes("/hooks?")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 1\nevent: hook.call\ndata: ${JSON.stringify({ frame: "hook.call", seq: 1, call })}\n\n`);
      res.end(`id: 2\nevent: session.closing\ndata: ${JSON.stringify({ frame: "session.closing", seq: 2, reason: "daemon_stopping" })}\n\n`);
      return;
    }
    res.writeHead(204); res.end();
  });
});
// Relative to this project (the cwd): a Unix socket path must stay under ~104 bytes, and TMPDIR may be long.
const socket = "d.sock";
await new Promise((r) => daemon.listen(socket, r));
const env = { CAPCOMD_PLUGIN_NAME: "smoke", CAPCOMD_PLUGIN_ROOT: dir, CAPCOMD_PLUGIN_DATA: dir, CAPCOMD_PLUGIN_SOCKET: socket, CAPCOMD_PLUGIN_SESSION: "ses_1", CAPCOMD_PLUGIN_TOKEN: "cch_smoke", CAPCOMD_PLUGIN_PROTOCOL: "1" };
const client = connect(env, { endWithStdin: false });
const open = sessionOpen(env);
assert.deepEqual({ ...open, manifestHash: open.manifestHash.length }, { session: "ses_1", protocol: PLUGIN_PROTOCOL_VERSION, manifestHash: 64, pid: process.pid, hooks: ["merge.landing"] });
await client.open(open);
const frames = [];
for await (const f of client.hooks(new AbortController().signal)) {
  frames.push(f.frame);
  if (f.frame === "hook.call") await client.answer(f.call.callId, { session: client.session, result: { decision: "deny", reason: "smoke" } });
}
daemon.close();
assert.deepEqual(frames, ["hook.call", "session.closing"]);
assert.deepEqual(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`), ["POST /v1/plugins/smoke/sessions", "GET /v1/plugins/smoke/hooks", "POST /v1/plugins/smoke/hooks/call_1"]);
assert.ok(seen.every((s) => s.auth === "Bearer cch_smoke"));
assert.deepEqual(seen[2].body, { session: "ses_1", result: { decision: "deny", reason: "smoke" } });
console.log(`@capcomd/plugin ${pkg.version} works on node ${process.version}`);
EOF
node use.mjs

step "a TypeScript consumer typechecks (nodenext)"
cat > tsconfig.json <<'EOF'
{ "compilerOptions": { "target": "ES2022", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true, "types": ["node"] }, "include": ["consumer.ts"] }
EOF
cat > consumer.ts <<'EOF'
import { sessionOpen, type HookFrame, type PluginClient, type PluginManifest, type VetoResult, type WireHookCall } from "@capcomd/plugin";
import { testkit, type BootOptions, type BootedDaemon } from "@capcomd/plugin/testkit";
import { connect } from "@capcomd/plugin/client";

const verdict = (call: WireHookCall): VetoResult => (call.hook === "merge.landing" ? { decision: "deny", reason: "no" } : { decision: "allow" });
export async function run(client: PluginClient = connect()): Promise<void> {
  await client.open(sessionOpen());
  for await (const f of client.hooks(new AbortController().signal) as AsyncIterable<HookFrame>)
    if (f.frame === "hook.call" && f.call.mode !== "observe") await client.answer(f.call.callId, { session: f.call.callId, result: verdict(f.call) });
}
export const boot = (m: PluginManifest, o: BootOptions) => testkit.bootWith([{ dir: "." }], async (d: BootedDaemon) => { await d.cli(["plugins", "list"]); void m; }, o);
EOF
npx tsc -p tsconfig.json

echo "SMOKE PASS"
