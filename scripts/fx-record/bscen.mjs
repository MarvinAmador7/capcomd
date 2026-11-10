// Writes the bridge scenario files for drive.mjs.
import { writeFileSync } from "node:fs";
const P = (s, t) => `[[scenario:${s}]] ${t}`;
const MCP = "/tmp/mcp-servers.json";
writeFileSync(MCP, JSON.stringify({ mcpServers: { capcomd: { command: "node", args: ["/rec/mcp.mjs"], env: { CAPCOMD_RPC_DIR: "/tmp/rpc" } }, other: { command: "no-such-program", args: [] } } }));
const S = [
  { name: "plain", prompt: P("plain", "Say hello.") },
  { name: "shell", stdin: true, prompt: P("shell", "List the files.") },
  { name: "failing", stdin: true, prompt: P("failing", "List /no/such/dir.") },
  { name: "edit", stdin: true, prompt: P("edit", "Create notes.txt and then edit it.") },
  { name: "steer", stdin: true, prompt: P("steer", "Run the slow command."), messages: [{ on: "tool_call", text: "Also, the answer must mention the word pineapple.", delayMs: 300 }] },
  { name: "followup", stdin: true, prompt: P("plain", "Say hello."), messages: [{ on: "result", text: "And once more, please." }] },
  { name: "auth", bearer: true, env: { STUB_API_KEY: "bad-key-123" }, stdin: true, prompt: P("auth", "Say hello.") },
  { name: "credits", stdin: true, prompt: P("credits", "Say hello.") },
  { name: "ratelimit", stdin: true, prompt: P("ratelimit", "Say hello."), bridge: { quotaAfterMs: 4000 } },
  { name: "steps", stdin: true, prompt: P("steps", "Run three commands."), bridge: { maxSteps: 2 } },
  { name: "orchestrate", stdin: true, prompt: P("orchestrate", "Look around but change nothing."), rules: "/rec/orchestrate-rules.json" },
  { name: "mcp", stdin: true, prompt: P("mcp", "Ask capcomd for the status."), bridge: { mcpConfig: MCP, mcpServers: ["capcomd", "other"], untrustedMcp: ["untrusted-one"] } },
  { name: "kill", stdin: true, prompt: P("steer", "Run the slow command."), killAfterMs: 2500 },
  // fx runs commands in a login shell, whose /etc/profile resets PATH: the agent's tools (a `capcomd` only on an extra
  // directory, setup.sh's) must still be found.
  { name: "path", stdin: true, prompt: P("path", "Check the path."), env: { PATH: "/tmp/xbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } },
  { name: "noauth", stdin: true, prompt: "Say hello.", bridge: { provider: "gateway" } },
];
for (const s of S) writeFileSync(`/rec/b-${s.name}.json`, JSON.stringify(s));
console.log(S.map((s) => s.name).join(" "));
