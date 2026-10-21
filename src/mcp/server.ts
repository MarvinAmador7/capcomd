// `capcomd mcp`: the capcomd tools over MCP on stdio, for agent callers such as Hermes.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { mkdirSync, openSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod";
import { SCHEMA, toRelayError } from "../core/errors";
import { approveTask, assertEngine, cancelRun, generateRunId, getStatus, listEvents, paginate } from "../core/relay";
import { loadTrace } from "../cli/commands/trace";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const CLI = join(REPO, "src", "cli", "index.ts");
/** Hard cap on the JSON text of one tool result. */
export const MAX_RESULT_CHARS = 20_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

function ok(payload: Record<string, unknown>): ToolResult {
  const body = { schema: SCHEMA, ok: true, ...payload };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
}

function fail(error: unknown): ToolResult {
  const body = toRelayError(error).toJSON();
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

/** Drop items from the end until the serialized result fits the cap. */
function fit<T>(items: T[], wrap: (items: T[], cut: boolean) => Record<string, unknown>) {
  let n = items.length;
  let cut = false;
  while (n > 0 && JSON.stringify(wrap(items.slice(0, n), cut)).length > MAX_RESULT_CHARS) {
    n = Math.max(0, Math.floor(n * 0.7));
    cut = true;
  }
  return { kept: items.slice(0, n), cut };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startDetachedRun(goal: string, runId: string, targetBranch?: string) {
  const dir = join(REPO, ".relay", "runs");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${runId}.ndjson`);
  const fd = openSync(log, "a");
  const args = [CLI, "run", "--json", "--run-id", runId];
  if (targetBranch) args.push("--target-branch", targetBranch);
  args.push(goal);
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env, cwd: REPO });
  child.unref();
  return { log, pid: child.pid };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "capcomd", version: "0.1.0" });

  server.registerTool(
    "capcomd_run",
    {
      description:
        "Start a capcomd run for a coding goal. Returns {runId} immediately; poll capcomd_status. " +
        "Set wait=true to block until the run finishes or a merge awaits approval (bounded by timeoutMs). " +
        "If targetBranch is protected (main, master, release/* by default) verified merges wait for capcomd_approve.",
      inputSchema: {
        goal: z.string().min(1).describe("What the run should accomplish"),
        runId: z.string().optional().describe("Resume or name a run; generated if omitted"),
        targetBranch: z.string().optional().describe("Branch tasks merge into"),
        wait: z.boolean().optional().describe("Block until terminal or awaiting approval"),
        timeoutMs: z.number().int().positive().max(600_000).optional().describe("Max wait, default 120000"),
      },
    },
    async ({ goal, runId, targetBranch, wait, timeoutMs }) => {
      try {
        await assertEngine();
        const id = runId ?? generateRunId();
        const { log } = startDetachedRun(goal, id, targetBranch);
        if (!wait) return ok({ runId: id, log, next: `Poll capcomd_status with runId ${id}.` });
        const deadline = Date.now() + (timeoutMs ?? 120_000);
        let status: Awaited<ReturnType<typeof getStatus>> | null = null;
        while (Date.now() < deadline) {
          await sleep(500);
          try {
            status = await getStatus(id);
          } catch {
            continue; // run actor not created yet
          }
          if (TERMINAL.has(status.state) || status.awaitingApproval.length > 0) break;
        }
        const waiting = status?.awaitingApproval ?? [];
        return ok({
          runId: id,
          log,
          status,
          timedOut: !status || (!TERMINAL.has(status.state) && waiting.length === 0),
          next: waiting.length
            ? `Approve with capcomd_approve {runId: "${id}", taskId: "${waiting[0]}"} after review.`
            : status && TERMINAL.has(status.state)
              ? `Run is ${status.state}. See capcomd_trace or capcomd_events.`
              : `Still running. Poll capcomd_status.`,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "capcomd_status",
    {
      description: "Current state of a run: lifecycle state, budget, per-task state and tasks awaiting approval.",
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) => {
      try {
        return ok({ run: await getStatus(runId) });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "capcomd_cancel",
    { description: "Cancel a run. Tasks parked for approval are cancelled too.", inputSchema: { runId: z.string().min(1) } },
    async ({ runId }) => {
      try {
        return ok(await cancelRun(runId));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "capcomd_events",
    {
      description:
        "Lifecycle events for a run, oldest first, cursor-paginated. Pass nextCursor back as cursor for the next page. " +
        "truncated=true means more events exist beyond this page.",
      inputSchema: {
        runId: z.string().min(1),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Default 100"),
      },
    },
    async ({ runId, cursor, limit }) => {
      try {
        const all = await listEvents(runId);
        const page = paginate(all, cursor, limit ?? 100);
        const start = cursor ? Number(cursor) : 0;
        const wrap = (items: unknown[], _cut: boolean) => ({ runId, events: items, nextCursor: null, total: page.total, truncated: true });
        const { kept, cut } = fit(page.items, wrap);
        const next = start + kept.length < page.total ? String(start + kept.length) : null;
        return ok({ runId, events: kept, nextCursor: next, total: page.total, truncated: next !== null || cut });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "capcomd_trace",
    {
      description:
        "Span waterfall for a run (actor actions, state transitions, model, sandbox and git calls), depth-first, " +
        "cursor-paginated like capcomd_events. truncated=true means more spans exist; pass nextCursor back as cursor.",
      inputSchema: {
        runId: z.string().min(1),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().describe("Max spans per page, default 200"),
      },
    },
    async ({ runId, cursor, limit }) => {
      try {
        const tree = loadTrace(runId);
        if (!tree) {
          const { RelayError } = await import("../core/errors");
          throw new RelayError("not_found", `No trace for run ${runId}`, "Traces appear once a run has started; check capcomd_status.");
        }
        const KEEP = ["relay.entity_id", "relay.state_from", "relay.state_to", "relay.task_id", "relay.killpoint",
          "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.response.cost", "git.ref", "sandbox.vm_id", "relay.outcome"];
        const slim = tree.spans.map((s) => ({
          name: s.name, spanId: s.spanId, parentSpanId: s.parentSpanId ?? null, depth: s.depth,
          offsetMs: s.offsetMs, durationMs: s.durationMs, status: s.status.code,
          attributes: Object.fromEntries(KEEP.filter((k) => s.attributes?.[k] !== undefined).map((k) => [k, s.attributes[k]])),
        }));
        const page = paginate(slim, cursor, limit ?? 200);
        const start = cursor ? Number(cursor) : 0;
        const wrap = (items: unknown[]) => ({ runId, traceId: tree.traceId, durationMs: tree.durationMs, spans: items, nextCursor: "0", total: slim.length, truncated: true });
        const { kept, cut } = fit(page.items, wrap);
        const next = start + kept.length < slim.length ? String(start + kept.length) : null;
        return ok({ runId, traceId: tree.traceId, durationMs: tree.durationMs, spans: kept, nextCursor: next, total: slim.length, truncated: next !== null || cut });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "capcomd_approve",
    {
      description: "Approve a verified task whose merge into a protected branch is parked in awaiting_approval. For an agent's parked merge (mrg-…), deny: true rejects it instead.",
      inputSchema: { runId: z.string().min(1), taskId: z.string().min(1), approvedBy: z.string().optional(), deny: z.boolean().optional(), reason: z.string().optional() },
    },
    async ({ runId, taskId, approvedBy, deny, reason }) => {
      try {
        if (taskId.startsWith("mrg-")) {
          const { decideMerge } = await import("../primitives/ops");
          return ok(await decideMerge(runId, taskId, { approve: !deny, by: approvedBy ?? "mcp", ...(reason ? { reason } : {}) }));
        }
        return ok(await approveTask(runId, taskId, approvedBy ?? "mcp"));
      } catch (error) {
        return fail(error);
      }
    }
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolveDone) => process.stdin.on("close", () => resolveDone()));
}
