// Imported first by the CLI. Keeps rivetkit's client logs off stdout for
// `--json` and `mcp`, where stdout must be pure JSON (MCP uses it for JSON-RPC).
const argv = process.argv.slice(2);
if ((argv.includes("--json") || argv[0] === "mcp") && !process.env.RIVET_LOG_LEVEL) {
  process.env.RIVET_LOG_LEVEL = "silent";
}
export {};
