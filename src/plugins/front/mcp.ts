// front-mcp (plugin API §4.7.2, §17.1, §17.2 step 8): the built-in front door for the user's own agent. It registers
// capcomd's MCP tools (src/mcp/tools.ts, as `capcomd_<tool>`: a kernel front door's names) with the server's
// instructions, and the `capcomd mcp` command that serves them on stdio (src/mcp/server.ts).
import { z } from "zod";
import { definePlugin } from "../../../packages/plugin/src/context";
import type { PluginManifest } from "../../../packages/plugin/src/manifest";
import { VERSION } from "../../utils/self";

/** capcomd's tools by name (without `capcomd_`) and a line each: what the manifest declares (§4.7). */
export const MCP_TOOLS: ReadonlyArray<{ name: string; summary: string }> = [
  { name: "projects", summary: "The projects this capcomd serves and which one is the default" },
  { name: "setup", summary: "Whether capcomd is ready here, the project's gates, how many agents run at once" },
  { name: "profiles", summary: "The agent profiles you can spawn and what each can do" },
  { name: "run_new", summary: "Start a run" },
  { name: "goal", summary: "A goal-branch run's result; mark a run you drive yourself done" },
  { name: "pr_open", summary: "Open a pull request from a run's goal branch" },
  { name: "runs", summary: "Recent runs on this machine" },
  { name: "tree", summary: "A run's agents as a tree" },
  { name: "inspect", summary: "Everything about one agent" },
  { name: "spawn", summary: "Start a coding agent on a task" },
  { name: "await", summary: "Wait for agents, verifies and merges" },
  { name: "send", summary: "Message a running agent" },
  { name: "title", summary: "Name an agent's tab" },
  { name: "cancel", summary: "Cancel an agent and its subtree, or the run" },
  { name: "resume", summary: "Run paused agents again" },
  { name: "grant", summary: "Give a live agent or the run more budget" },
  { name: "verify", summary: "Run the checks and the reviewer on an agent's work" },
  { name: "merge", summary: "Land the commit a passing verify tested" },
  { name: "check", summary: "Run the checks on a branch's commit as it is" },
  { name: "approve", summary: "Approve or deny a merge parked for approval (a person decides)" },
  { name: "task", summary: "The run's task board" },
  { name: "kv", summary: "The run's shared blackboard" },
  { name: "budget", summary: "A run's or an agent's budget and spend" },
  { name: "events", summary: "A run's lifecycle events" },
  { name: "trace", summary: "A run's span waterfall" },
];

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "front-mcp", version: VERSION,
  description: "capcomd's MCP server for your own agent (Claude Code, Codex, Hermes): the tools that start runs, spawn agents, verify and merge their work, and the `capcomd mcp` command that serves them.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./mcp.ts" }, order: "pre",
  contributes: { cli: [{ name: "mcp", summary: "Serve capcomd's primitives over MCP (stdio), for your agent" }], mcp: MCP_TOOLS.map((t) => ({ ...t })) },
};

export const plugin = definePlugin({
  async activate(ctx) {
    const T = await import("../../mcp/tools");
    for (const t of T.kernelTools()) {
      ctx.mcp.tool({
        name: t.name, title: t.title, description: t.description,
        // The JSON Schema the MCP SDK listed for this zod shape before the tools were registrations (draft-07, input).
        inputSchema: z.toJSONSchema(z.object(t.inputSchema), { target: "draft-7", io: "input" }) as Record<string, unknown>,
        annotations: t.annotations, ...(t._meta ? { _meta: t._meta } : {}),
        run: ({ args }) => t.run(args),
      });
    }
    ctx.mcp.instructions(T.INSTRUCTIONS);
    ctx.cli.command({
      name: "mcp", summary: "Serve capcomd's primitives over MCP (stdio), for your agent", usage: ["capcomd mcp"],
      run: async () => { await (await import("../../mcp/server")).runMcpServer(); return { exit: 0 }; },
    });
  },
});
