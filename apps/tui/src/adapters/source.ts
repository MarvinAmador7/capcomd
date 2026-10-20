import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEvents } from "./events";
import { parseTrace } from "./trace";
import { agentsFromTrace, parseTree } from "./tree";
import type { RunData } from "./types";

export const FIXTURE_DIR = resolve(import.meta.dir, "../../fixtures");

export function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** A fixture is a folder with any of: trace.ndjson, events.ndjson, tree.json, meta.json. */
export function loadFixture(name: string): RunData {
  const dir = join(FIXTURE_DIR, name);
  if (!existsSync(dir)) throw new Error(`no fixture "${name}" (have: ${listFixtures().join(", ")})`);
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  const meta = read("meta.json") ? JSON.parse(read("meta.json")) : {};
  return assemble({ trace: read("trace.ndjson"), events: read("events.ndjson"), tree: read("tree.json"), source: `fixture:${name}`, meta });
}

export function assemble(o: { trace: string; events: string; tree: string; source: string; runId?: string; meta?: any }): RunData {
  const trace = parseTrace(o.trace, o.runId ?? o.meta?.runId);
  const events = parseEvents(o.events);
  const fromTree = parseTree(o.tree);
  const runId = o.runId ?? o.meta?.runId ?? trace?.runId ?? String((events[0]?.data as any)?.runId ?? "unknown");
  const started = events.find((e) => e.type === "run.started");
  const result = [...events].reverse().find((e) => e.type === "run.result" || e.type.startsWith("run.") && /completed|failed|cancelled/.test(e.type));
  const err = events.find((e) => e.type === "cli.error");
  const state = (result?.data.state as string) ?? (result ? result.type.slice(4) : err ? "failed" : undefined);
  return {
    runId, source: o.source, goal: (started?.data.goal as string) ?? o.meta?.goal, state: state ?? o.meta?.state ?? (events.length ? undefined : "trace only"),
    trace, events, agents: fromTree.length ? fromTree : agentsFromTrace(trace), agentsFromTree: fromTree.length > 0,
  };
}

/** Live: shell out to the capcomd CLI (override with CAPCOMD_BIN, e.g. "bun /path/src/cli/index.ts"). */
export async function loadLive(runId: string): Promise<RunData> {
  const bin = (process.env.CAPCOMD_BIN ?? `bun ${resolve(import.meta.dir, "../../../../src/cli/index.ts")}`).split(" ");
  const run = async (args: string[]) => {
    const p = Bun.spawn([...bin, ...args], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    return text;
  };
  const [trace, events, tree] = await Promise.all([
    run(["trace", runId, "--json"]), run(["events", runId, "--json"]), run(["tree", runId, "--json"]),
  ]);
  return assemble({ trace, events, tree: tree.includes('"ok":true') ? tree : "", source: "live", runId });
}
