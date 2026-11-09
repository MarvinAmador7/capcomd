// A minimal stdio MCP server with one tool, `status`, standing in for capcomd's own.
import { appendFileSync } from "node:fs";
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    appendFileSync("/out/mcp.log", JSON.stringify({ env: process.env.CAPCOMD_RPC_DIR ?? null, m }) + "\n");
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "capcomd", version: "0.0.0" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "status", description: "The run's status.", inputSchema: { type: "object", properties: {} } }] } });
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "run is ok" }] } });
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
  }
});
