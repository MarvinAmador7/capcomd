import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-trace-"));
  process.env.CAPCOMD_TRACE_DIR = dir;
});
afterAll(() => {
  delete process.env.CAPCOMD_TRACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("trace persistence", () => {
  test("actor actions, nested calls and transitions land in one NDJSON per run", async () => {
    const t = await import("../../src/utils/tracing-simple");
    const { loadTrace } = await import("../../src/cli/commands/trace");
    const model = t.traceMethods("model", { async generate() { return 7; } });
    const actions = t.traceActions("demo", {
      async doThing(_c: any, p: { runId: string; taskId: string }) {
        await model.generate();
        await t.withSpan("transition.task", {}, async () => {});
        return p.taskId;
      },
      async getThing() { return 1; },
    });
    expect(await actions.doThing({ key: ["x"] }, { runId: "run-p1", taskId: "task-1" })).toBe("task-1");
    await actions.getThing({});

    const lines = readFileSync(t.tracePath("run-p1"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((s) => s.name).sort()).toEqual(["actor.demo.doThing", "model.generate", "transition.task"]);
    const action = lines.find((s) => s.name === "actor.demo.doThing");
    expect(action.parentSpanId).toBe(t.rootSpanIdForRun("run-p1"));
    for (const s of lines) {
      expect(s.traceId).toBe(t.traceIdForRun("run-p1"));
      expect(s.attributes["relay.run_id"]).toBe("run-p1");
      if (s !== action) expect(s.parentSpanId).toBe(action.spanId);
    }
    const tree = loadTrace("run-p1")!;
    expect(tree.spans.map((s) => [s.name, s.depth])).toEqual([
      ["relay.run", 0],
      ["actor.demo.doThing", 1],
      ["model.generate", 2],
      ["transition.task", 2],
    ]);
  });
});
