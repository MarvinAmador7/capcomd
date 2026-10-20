import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, REPO, ensureEngine, sleep } from "../helpers/engine";

let engine: { stop: () => Promise<void> };
let mcp: Client;

const call = async (name: string, args: Record<string, unknown>) => {
  const res: any = await mcp.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
};

beforeAll(async () => {
  engine = await ensureEngine("mcp");
  mcp = new Client({ name: "hermes-test", version: "0.0.1" });
  await mcp.connect(new StdioClientTransport({ command: "bun", args: [CLI, "mcp"], cwd: REPO, stderr: "ignore" }));
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  await engine?.stop();
});

describe("capcomd mcp", () => {
  test("lists the six relay tools", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "capcomd_approve", "capcomd_cancel", "capcomd_events", "capcomd_run", "capcomd_status", "capcomd_trace",
    ]);
  });

  test("errors are typed and say what to do next", async () => {
    const r = await call("capcomd_status", { runId: `run-nope-${Date.now()}` });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe("not_found");
    expect(r.body.error.hint.length).toBeGreaterThan(0);
  });

  test("drives a full run to a protected branch through approval", async () => {
    const runId = `run-mcp-${Date.now()}`;
    const started = await call("capcomd_run", { goal: "Add a feature", runId, targetBranch: "main", wait: true, timeoutMs: 90_000 });
    expect(started.isError).toBe(false);
    expect(started.body.runId).toBe(runId);
    expect(started.body.status.awaitingApproval).toEqual(["task-1"]);
    expect(started.body.next).toContain("capcomd_approve");

    const taskIds: string[] = started.body.status.tasks.map((t: any) => t.taskId);
    expect(taskIds.length).toBeGreaterThan(1);
    for (const taskId of taskIds) {
      for (let i = 0; i < 60; i++) {
        const s = await call("capcomd_status", { runId });
        if (s.body.run.awaitingApproval.includes(taskId)) break;
        await sleep(500);
      }
      const a = await call("capcomd_approve", { runId, taskId, approvedBy: "hermes" });
      expect(a.isError).toBe(false);
      expect(a.body.state).toBe("approved");
    }

    let state = "";
    for (let i = 0; i < 60 && state !== "completed"; i++) {
      state = (await call("capcomd_status", { runId })).body.run.state;
      if (state !== "completed") await sleep(500);
    }
    expect(state).toBe("completed");

    // cursor pagination with an explicit truncated flag
    const p1 = await call("capcomd_events", { runId, limit: 4 });
    expect(p1.body.events.length).toBe(4);
    expect(p1.body.truncated).toBe(true);
    expect(p1.body.nextCursor).toBe("4");
    const all = [...p1.body.events];
    let cursor = p1.body.nextCursor;
    let last = p1.body;
    while (cursor) {
      last = (await call("capcomd_events", { runId, limit: 4, cursor })).body;
      all.push(...last.events);
      cursor = last.nextCursor;
    }
    expect(last.truncated).toBe(false);
    expect(all.length).toBe(p1.body.total);
    expect(all.filter((e: any) => e.type === "APPROVED").length).toBe(taskIds.length);

    const trace = await call("capcomd_trace", { runId, limit: 5 });
    expect(trace.body.spans.length).toBe(5);
    expect(trace.body.truncated).toBe(true);
    const names: string[] = [];
    let tc: string | null = null;
    do {
      const pg: any = (await call("capcomd_trace", { runId, limit: 1000, ...(tc ? { cursor: tc } : {}) })).body;
      names.push(...pg.spans.map((s: any) => s.name));
      expect(pg.truncated).toBe(pg.nextCursor !== null);
      tc = pg.nextCursor;
    } while (tc);
    expect(names.length).toBe(trace.body.total);
    expect(names).toContain("actor.taskBoard.approveTask");
    expect(names).toContain("git.push");

    const cancelled = await call("capcomd_cancel", { runId });
    expect(cancelled.body).toMatchObject({ ok: true, changed: false, state: "completed" });
  }, 240_000);
});
