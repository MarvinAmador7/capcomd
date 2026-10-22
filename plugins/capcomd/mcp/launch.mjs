// The capcomd plugin's MCP server, without dependencies (it runs from the installed plugin directory).
// An installed capcomd at least as new as this plugin (same major.minor or newer) → `capcomd mcp` in the user's
// project, with stdio passed through. Otherwise a one-tool MCP server: `capcomd_setup` explains what to install,
// so the agent can tell the user (or do it) instead of finding no tools at all.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const want = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
const isDir = (p) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };

// The user's project: Claude Code passes it in; Codex starts us in the plugin root, so its PWD is the session's.
const project = [process.env.CAPCOMD_PROJECT_DIR, process.env.PWD, process.cwd()].find((d) => isDir(d) && d !== root && !d.includes("${")) ?? homedir();

function which(name) {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) { const p = join(d, name); if (d && existsSync(p)) return p; }
  return null;
}
const parse = (v) => (String(v ?? "").match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const atLeast = (have, need) => { const [a, b] = parse(have), [c, d] = parse(need); return a > c || (a === c && b >= d); };

const capcomd = which("capcomd");
const bun = which("bun");
// capcomd is a Bun program: run it with bun explicitly (its `#!/usr/bin/env bun` needs bun on PATH).
const cmd = capcomd ? (bun ? [bun, capcomd] : [capcomd]) : null;
const env = { ...process.env, PATH: [bun && dirname(bun), capcomd && dirname(capcomd), process.env.PATH].filter(Boolean).join(delimiter) };
let have = null;
if (cmd) {
  const r = spawnSync(cmd[0], [...cmd.slice(1), "--version", "--json"], { env, cwd: project, encoding: "utf8", timeout: 20_000 });
  try { have = JSON.parse(r.stdout.trim().split("\n").pop()).version ?? null; } catch { have = null; }
}

if (cmd && have && atLeast(have, want)) {
  const child = spawn(cmd[0], [...cmd.slice(1), "mcp"], { env, cwd: project, stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  const problem = !bun ? "Bun isn't installed (capcomd runs on Bun)"
    : !cmd ? "the capcomd CLI isn't installed"
    : !have ? `the installed capcomd (${capcomd}) didn't report its version`
    : `the installed capcomd is ${have}; this plugin needs ${want} or newer`;
  const install = [...(!bun ? ["curl -fsSL https://bun.sh/install | bash"] : []), `bun add -g capcomd@${want}`, "capcomd setup"];
  const info = {
    schema: "relay.v1", ok: false, ready: false, problem, install,
    next: `Tell the user: ${problem}. Install with \`${install.join(" && ")}\` in a terminal (setup is interactive for logins), then restart this session so the capcomd tools load.`,
  };
  const tools = [{ name: "capcomd_setup", title: "Setup", description: "capcomd isn't ready on this machine: what's missing and how to install it. Call this first.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }];
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return; // notifications
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "capcomd", version: want } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info, isError: true } });
    else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }).on("close", () => process.exit(0));
}
