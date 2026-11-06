// `capcomd mcp`: capcomd's primitives over MCP on stdio, for the user's own agent driving a swarm (ADR-018).
// The tools are registrations (plugin API §4.7.2, §17.2 step 8): the built-in front door front-mcp registers capcomd's
// own (./tools.ts, as `capcomd_<tool>`) and a plugin may add its own (`capcomd_<plugin>_<tool>`), in this process's
// plugin host (src/plugins/host.ts `localHost`). This file serves them: it lists each with its own JSON Schema, checks
// a call's arguments against it, runs the handler with the driver's principal within the call's session (./session.ts)
// and answers with the relay.v1 envelope.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpToolSpec } from "../../packages/plugin/src/context";
import type { Principal } from "../../packages/plugin/src/shapes";
import { RelayError, SCHEMA } from "../core/errors";
import { isEnvelope, relayErrorOf } from "../cli/front-doors";
import { VERSION } from "../utils/self";
import { ProjectServers } from "./projects";
import { Forwarded, inCall } from "./session";

export { INSTRUCTIONS, MAX_RESULT_CHARS, noProjectsHint } from "./tools";

/** The per-project servers sessions in this process started (closed when the session ends). */
const sessions = new Set<ProjectServers>();

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

function ok(payload: Record<string, unknown>): ToolResult {
  const body = { schema: SCHEMA, ok: true, ...payload };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
}

function fail(error: RelayError): ToolResult {
  const body = error.toJSON();
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

/** Tool calls being answered (a project's server waits for them before it exits). */
let inflight = 0;

/** Who calls a tool here: the user's own agent, through `capcomd mcp` (§3.2, ADR-018 §4). */
const DRIVER: Principal = { kind: "driver", clientId: null };

/** A tool as this process's plugins registered it. */
export interface ServedTool { name: string; plugin: string; spec: McpToolSpec }

/** What the server serves: the tools and the instructions this process's plugin host holds (§4.7.2). */
export async function servedTools(): Promise<{ tools: ServedTool[]; instructions: string }> {
  const { localHost } = await import("../plugins/host");
  const { KERNEL_SURFACE } = await import("../plugins/builtins");
  const host = await localHost();
  const tools = host.contributions.list("mcp").map((c) => ({ name: c.key, plugin: c.plugin, spec: c.value.spec }));
  // The kernel's text first, as it always was; a plugin's under a heading with its name.
  const texts = host.contributions.list("instructions");
  const instructions = [...texts.filter((t) => KERNEL_SURFACE.has(t.plugin)).map((t) => t.value.text), ...texts.filter((t) => !KERNEL_SURFACE.has(t.plugin)).map((t) => `## ${t.plugin}\n${t.value.text}`)].join("\n\n");
  return { tools, instructions };
}

/** Only the properties the schema names (a client's extra argument never reaches a handler). */
function named(args: Record<string, unknown> | undefined, schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : null;
  if (!props || schema.additionalProperties === true) return { ...(args ?? {}) };
  return Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => props.includes(k)));
}

export function buildServer(served: { tools: ServedTool[]; instructions: string }): McpServer {
  const server = new McpServer({ name: "capcomd", version: VERSION }, { instructions: served.instructions });
  const kids = new ProjectServers(server.server);
  sessions.add(kids);
  const tools: ServedTool[] = [];
  for (const t of served.tools) {
    const { spec } = t;
    // The SDK checks the arguments with this; the listing below shows the plugin's own schema. A schema zod can't read
    // leaves that one tool out, never the server.
    let check: z.ZodType;
    try { check = z.fromJSONSchema(spec.inputSchema as Parameters<typeof z.fromJSONSchema>[0]); } catch (e) {
      console.error(`capcomd mcp: the ${t.plugin} plugin's tool ${t.name} is left out: its inputSchema isn't a JSON Schema capcomd can check (${(e as Error).message})`);
      continue;
    }
    tools.push(t);
    server.registerTool(t.name, {
      ...(spec.title !== undefined ? { title: spec.title } : {}), description: spec.description,
      inputSchema: check as unknown as z.ZodObject<z.ZodRawShape>,
      ...(spec.annotations ? { annotations: spec.annotations } : {}), ...(spec._meta ? { _meta: spec._meta } : {}),
    }, async (a: Record<string, unknown>, extra: { signal: AbortSignal }): Promise<ToolResult> => {
      inflight++;
      try {
        const body = await inCall({ server: server.server, kids, signal: extra.signal }, () => spec.run({ args: named(a, spec.inputSchema), principal: DRIVER, signal: extra.signal }));
        if (!isEnvelope(body)) throw new RelayError("run_failed", `the ${t.plugin} plugin's tool ${t.name} didn't answer with a relay.v1 envelope`, `Report it to the ${t.plugin} plugin's author.`, { code: `plugin:${t.plugin}` });
        return ok(body);
      } catch (e) {
        if (e instanceof Forwarded) return e.result as ToolResult;
        return fail(relayErrorOf(e, t.plugin, `The ${t.plugin} plugin refused it.`));
      } finally { inflight--; }
    });
  }
  // Each tool listed with the JSON Schema its plugin registered, exactly (the SDK would list its own rendering of the
  // schema it checks with); otherwise the SDK's listing, field for field (`registerTool`'s tools run no MCP tasks).
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name, title: t.spec.title, description: t.spec.description, inputSchema: t.spec.inputSchema as { type: "object" },
      annotations: t.spec.annotations, execution: { taskSupport: "forbidden" as const }, _meta: t.spec._meta,
    })),
  }));
  return server;
}

export async function runMcpServer(): Promise<void> {
  // Start the engine in the background if none answers, so the first tool call usually finds it up.
  void (await import("../core/engine-start")).ensureEngine({ timeoutMs: 90_000 }).catch(() => {});
  const server = buildServer(await servedTools());
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolveDone) => process.stdin.on("close", () => resolveDone()));
  // The servers started for other projects end with this session.
  await Promise.all([...sessions].map((k) => k.close()));
  // A project's server (started by another `capcomd mcp`) ends with its session, which may have been killed without
  // closing it: finish the calls in flight (bounded waits), then exit.
  if (process.env.CAPCOMD_MCP_CHILD) {
    for (let i = 0; i < 120 && inflight > 0; i++) await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  }
}
