// One MCP tool call's session (src/mcp/server.ts): the tools are registrations in the plugin host (plugin API §4.7.2),
// shared by every session of the process, so what belongs to the session a call came in on (its MCP server, for
// elicitation and the client's name; the servers it started for other projects; the call's signal) is passed down the
// call itself. Kernel-internal: front-mcp's tools (./tools.ts) read it; a plugin's tool gets `{args, principal, signal}`.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectServers } from "./projects";

/** Waits return before a client's tool timeout (Codex defaults to 60s); the caller asks again. */
export const WAIT_DEFAULT_MS = 25_000;
export const WAIT_MAX_MS = 55_000;

export interface McpCall {
  server: Server;
  kids: ProjectServers;
  signal?: AbortSignal;
}

const calls = new AsyncLocalStorage<McpCall>();

/** Run a tool's handler within its call's session. */
export const inCall = <T>(call: McpCall, fn: () => Promise<T>): Promise<T> => calls.run(call, fn);

/** The session of the tool call being answered. */
export function mcpCall(): McpCall {
  const c = calls.getStore();
  if (!c) throw new Error("not inside an MCP tool call");
  return c;
}

/** A call another project's server answered: its result goes back to the client exactly as that server gave it. */
export class Forwarded {
  constructor(readonly result: CallToolResult) {}
}
export const forwarded = (result: CallToolResult) => new Forwarded(result);
