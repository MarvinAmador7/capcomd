// One `capcomd mcp` for all of the user's projects (P1b, docs/proposals/hermes.md). A tool call acts on one project:
// the `project` it names (a configured name or path), else the run's own project, else the checkout the server runs
// in, else the configured default, else the only project. A project's gates, driver policy and agent profiles come
// from its checkout (.capcomd/config.json, .capcomd/agents.json), read relative to the process's directory and
// environment; so a call for another project is answered by a `capcomd mcp` started in that checkout (one per
// project, on demand), with this session's client name and elicitation passed through.
import { existsSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { RelayError } from "../core/errors";
import { findProject, projectDirOf, projectNameOf, readProjects, samePath } from "../config/projects";
import { STARTUP_ENV } from "../utils/startup-env";
import { selfArgv } from "../utils/self";

export interface Target { name: string; path: string }

/** The project this server runs in: the checkout holding the nearest .capcomd/config.json. */
export function selfProject(cwd = process.cwd()): Target | null {
  const dir = projectDirOf(cwd);
  if (!dir) return null;
  const listed = readProjects().list.find((x) => samePath(x.path, dir));
  return listed ? { name: listed.name, path: listed.path } : { name: projectNameOf(dir), path: dir };
}

/** The project a run was started in (the runs index records the directory), when known. */
export async function runProject(runId: string): Promise<Target | null> {
  const { recentRuns } = await import("../primitives/ops");
  const row = recentRuns(100_000).find((r) => r.runId === runId);
  return row?.cwd ? selfProject(row.cwd) : null;
}

const listing = (l: Target[]) => l.map((p) => `${p.name} (${p.path})`).join(", ");

/** The project a call acts on, or null when there is none (no projects configured, not in a checkout). */
export async function resolveTarget(arg: string | undefined, runId: string | undefined, cwd = process.cwd()): Promise<Target | null> {
  const { default: dflt, list } = readProjects();
  const me = selfProject(cwd);
  const ofRun = runId ? await runProject(runId) : null;
  if (arg !== undefined && arg !== "") {
    let p: Target | null = findProject(arg, list);
    if (!p && me && (arg === me.name || samePath(arg.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"), me.path))) p = me;
    if (!p) throw new RelayError("usage", `unknown project "${arg}"`, list.length
      ? `Known projects: ${listing(list)} (capcomd_projects lists them). To add one, the user runs \`capcomd setup agent\` in its checkout.`
      : "No projects are configured: the user runs `capcomd setup agent` in a repository's checkout to add it.", { code: "unknown_project" });
    if (ofRun && !samePath(ofRun.path, p.path)) throw new RelayError("usage", `run ${runId} belongs to project ${ofRun.name}, not ${p.name}`, `Pass project: "${ofRun.name}" (or leave it out: a run's own project applies).`, { code: "wrong_project" });
    return p;
  }
  if (ofRun) return ofRun;
  if (me) return me;
  const d = dflt ? list.find((x) => x.name === dflt) : undefined;
  if (d) return d;
  if (list.length === 1) return list[0]!;
  if (list.length > 1) throw new RelayError("usage", "which project? several are configured and none is the default", `Pass project: one of ${listing(list)}. (\`capcomd setup agent --default-project\` in a checkout makes it the default.)`, { code: "project_required" });
  return null;
}

/** The client declared form elicitation (MCP 2025-06: a bare `elicitation: {}` means form). */
export function hasFormElicitation(caps: { elicitation?: unknown } | undefined): boolean {
  const e = caps?.elicitation as Record<string, unknown> | undefined;
  return !!e && typeof e === "object" && (Object.keys(e).length === 0 || (!!e.form && typeof e.form === "object"));
}

/** The servers this session started for other projects, by checkout. */
export class ProjectServers {
  private kids = new Map<string, Promise<Client>>();
  constructor(private upstream: Server) {}

  private async start(t: Target): Promise<Client> {
    if (!existsSync(t.path)) throw new RelayError("config", `project ${t.name}'s checkout ${t.path} doesn't exist`, "Fix its path in the user's ~/.capcomd/config.json (projects), or have them run `capcomd setup agent` in the checkout.");
    const form = hasFormElicitation(this.upstream.getClientCapabilities());
    const info = this.upstream.getClientVersion();
    // The project's server sees this session's client: its name, and form elicitation only if this client has it.
    const c = new Client({ name: info?.name ?? "unknown", version: info?.version ?? "0" }, { capabilities: form ? { elicitation: { form: {} } } : {} });
    if (form) c.setRequestHandler(ElicitRequestSchema, (req, extra) => this.upstream.elicitInput(req.params as any, { signal: extra.signal, timeout: 3_600_000 }));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(STARTUP_ENV)) if (v !== undefined) env[k] = v;
    env.CAPCOMD_MCP_CHILD = "1";
    const [command, ...args] = selfArgv("mcp");
    const key = t.path;
    c.onclose = () => { this.kids.delete(key); };
    try {
      await c.connect(new StdioClientTransport({ command: command!, args, cwd: t.path, env, stderr: "inherit" }));
    } catch (e) {
      throw new RelayError("config", `couldn't start capcomd for project ${t.name} (${t.path}): ${(e as Error).message}`, "Check the checkout and its .capcomd/config.json, then try again.", { retryable: true });
    }
    return c;
  }

  /** The tool call, answered by the project's own server. */
  async call(t: Target, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    let p = this.kids.get(t.path);
    if (!p) { p = this.start(t); this.kids.set(t.path, p); p.catch(() => this.kids.delete(t.path)); }
    const c = await p;
    return (await c.callTool({ name, arguments: args }, undefined, { ...(signal ? { signal } : {}), timeout: 3_600_000 })) as CallToolResult;
  }

  async close(): Promise<void> {
    const all = [...this.kids.values()];
    this.kids.clear();
    await Promise.all(all.map(async (p) => { try { await (await p).close(); } catch {} }));
  }
}
