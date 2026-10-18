import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureEngine, relay, sleep } from "../helpers/engine";

const lines = (s: string) => s.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("relay CLI exit codes without an engine", () => {
  test("usage errors exit 2 with a JSON error", async () => {
    const r = await relay(["run", "--json"]);
    expect(r.code).toBe(2);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({ schema: "relay.v1", ok: false, error: { code: "usage" } });
    expect(body.error.hint).toContain("relay --help");
  });

  test("unknown flags exit 2", async () => {
    const r = await relay(["status", "x", "--bogus", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe("usage");
  });

  test("unknown command exits 2", async () => {
    expect((await relay(["frobnicate"])).code).toBe(2);
  });

  test("engine unreachable exits 4", async () => {
    const r = await relay(["status", "run-x", "--json"], { RELAY_ENDPOINT: "http://127.0.0.1:6499" });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "engine_unreachable" });
    const run = await relay(["run", "goal", "--json"], { RELAY_ENDPOINT: "http://127.0.0.1:6499" });
    expect(run.code).toBe(4);
  });

  test("trace for an unknown run exits 3", async () => {
    const r = await relay(["trace", "run-does-not-exist", "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error.code).toBe("not_found");
  });
});

describe("relay CLI against a live engine", () => {
  let engine: { stop: () => Promise<void> };
  beforeAll(async () => {
    engine = await ensureEngine("cli");
  }, 120_000);
  afterAll(async () => {
    await engine?.stop();
  });

  let runId = "";

  test("run --json streams NDJSON and ends with run.result", async () => {
    runId = `run-clijson-${Date.now()}`;
    const r = await relay(["run", "--json", "--run-id", runId, "Build a thing"]);
    expect(r.code).toBe(0);
    const evs = lines(r.stdout);
    for (const e of evs) {
      expect(e.schema).toBe("relay.v1");
      expect(e.runId).toBe(runId);
      expect(typeof e.type).toBe("string");
      expect(typeof e.ts).toBe("string");
    }
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("plan.ready");
    const planned = evs.find((e) => e.type === "plan.ready").tasks.length;
    expect(planned).toBeGreaterThan(0);
    expect(types.filter((t) => t === "task.merged").length).toBe(planned);
    expect(evs.at(-1)).toMatchObject({ type: "run.result", ok: true, state: "completed" });
  }, 120_000);

  test("status --json has the stable shape", async () => {
    const r = await relay(["status", runId, "--json"]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.schema).toBe("relay.v1");
    expect(body.ok).toBe(true);
    expect(Object.keys(body.run).sort()).toEqual(["awaitingApproval", "budget", "events", "goal", "runId", "state", "tasks"]);
    expect(body.run.state).toBe("completed");
    expect(body.run.tasks.length).toBeGreaterThan(0);
    expect(body.run.tasks.every((t: any) => t.state === "merged")).toBe(true);
  });

  test("status of an unknown run exits 3", async () => {
    const r = await relay(["status", `run-missing-${Date.now()}`, "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error.code).toBe("not_found");
  });

  test("events --json paginates with an explicit truncated flag", async () => {
    const first = JSON.parse((await relay(["events", runId, "--json", "--limit", "5"])).stdout);
    expect(first.events.length).toBe(5);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe("5");
    const seen = [...first.events];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = JSON.parse((await relay(["events", runId, "--json", "--limit", "5", "--cursor", cursor])).stdout);
      seen.push(...page.events);
      cursor = page.nextCursor;
      if (!cursor) expect(page.truncated).toBe(false);
    }
    expect(seen.length).toBe(first.total);
  }, 60_000);

  test("trace --json has actor, transition, model, sandbox and git spans", async () => {
    const r = await relay(["trace", runId, "--json"]);
    expect(r.code).toBe(0);
    const { trace } = JSON.parse(r.stdout);
    const names: string[] = trace.spans.map((s: any) => s.name);
    expect(names[0]).toBe("relay.run");
    expect(names).toContain("cli.run");
    expect(names.some((n) => n.startsWith("actor.taskBoard."))).toBe(true);
    expect(names.some((n) => n.startsWith("transition.task"))).toBe(true);
    expect(names).toContain("model.generate");
    expect(names).toContain("sandbox.ensure");
    expect(names).toContain("git.push");
    expect(names).toContain("git.merge_cas");
    for (const s of trace.spans) expect(s.traceId).toBe(trace.traceId);
  });

  test("cancel --json on a finished run reports no change", async () => {
    const body = JSON.parse((await relay(["cancel", runId, "--json"])).stdout);
    expect(body).toMatchObject({ ok: true, runId, changed: false, state: "completed" });
  });

  test("run --json --detach returns {runId}; protected merge waits for approve", async () => {
    const id = `run-approve-${Date.now()}`;
    const r = await relay(["run", "--json", "--detach", "--run-id", id, "--target-branch", "main", "Ship to main"]);
    expect(r.code).toBe(0);
    const started = JSON.parse(r.stdout);
    expect(started).toMatchObject({ schema: "relay.v1", ok: true, runId: id, detached: true });

    let status: any;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const s = await relay(["status", id, "--json"]);
      if (s.code !== 0) continue;
      status = JSON.parse(s.stdout).run;
      if (status.awaitingApproval.length) break;
    }
    expect(status.awaitingApproval).toEqual(["task-1"]);
    expect(status.state).toBe("executing");

    const early = await relay(["approve", id, status.tasks[1].taskId, "--json"]);
    expect(early.code).toBe(1);
    expect(JSON.parse(early.stdout).error.code).toBe("conflict");

    const taskIds: string[] = status.tasks.map((t: any) => t.taskId);
    expect(taskIds.length).toBeGreaterThan(1);
    for (const taskId of taskIds) {
      for (let i = 0; i < 60; i++) {
        const s = JSON.parse((await relay(["status", id, "--json"])).stdout).run;
        if (s.awaitingApproval.includes(taskId)) break;
        await sleep(500);
      }
      const a = await relay(["approve", id, taskId, "--json"]);
      expect(a.code).toBe(0);
      expect(JSON.parse(a.stdout)).toMatchObject({ ok: true, taskId, state: "merged" });
    }

    for (let i = 0; i < 60; i++) {
      status = JSON.parse((await relay(["status", id, "--json"])).stdout).run;
      if (status.state === "completed") break;
      await sleep(500);
    }
    expect(status.state).toBe("completed");
    const evs = JSON.parse((await relay(["events", id, "--json"])).stdout).events.map((e: any) => e.type);
    expect(evs.filter((t: string) => t === "VERIFIED_AWAITING_APPROVAL").length).toBe(taskIds.length);
    expect(evs.filter((t: string) => t === "APPROVED").length).toBe(taskIds.length);
    expect(evs).not.toContain("VERIFIED_AND_MERGED");
  }, 180_000);
});
