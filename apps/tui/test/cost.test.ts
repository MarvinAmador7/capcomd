import { describe, expect, test } from "bun:test";
import { parseTrace } from "../src/adapters/trace";
import { agentsFromTrace, parseTree } from "../src/adapters/tree";
import { cost } from "../src/format";

const span = (spanId: string, name: string, attributes: Record<string, unknown>, parentSpanId?: string) =>
  ({ traceId: "t", spanId, ...(parentSpanId ? { parentSpanId } : {}), name, startTime: 0, endTime: 1000, attributes, events: [], status: { code: 1 } });

describe("subscription costs (billed $0, API-price estimate shown as ~$)", () => {
  test("cost(): billed wins; else the estimate with ~; else $0.00", () => {
    expect(cost(0.12, 0.3)).toBe("$0.12");
    expect(cost(0, 0.0889)).toBe("~$0.09");
    expect(cost(0, 0.004)).toBe("~$0.0040");
    expect(cost(0, 0)).toBe("$0.00");
    expect(cost(undefined)).toBe("—");
  });

  test("tree JSON carries notionalUsd per agent", () => {
    const [p] = parseTree(JSON.stringify({ tree: [{ agentId: "agt-p", status: "done", spent: { usd: 0, turns: 7 }, budget: {}, notionalUsd: 0.089, children: [] }] }));
    expect(p!.notionalUsd).toBe(0.089);
  });

  test("traces: from agent.run, else (older traces) from the CLI span under it", () => {
    const trace = parseTrace([
      span("r", "relay.run", { "relay.run_id": "run-x" }),
      span("p", "agent.run", { "relay.agent_id": "agt-p", "agent.cost_usd": 0, "agent.turns": 7, "agent.notional_cost_usd": 0.089 }, "r"),
      span("c", "agent.run", { "relay.agent_id": "agt-c", "relay.parent_agent_id": "agt-p", "agent.cost_usd": 0, "agent.turns": 5 }, "p"),
      span("cc", "agent.codex", { "agent.id": "agt-c", "agent.billing": "subscription", "agent.cost_usd": 0, "agent.notional_cost_usd": 0.059 }, "c"),
    ].map((s) => JSON.stringify(s)).join("\n"))!;
    const [p] = agentsFromTrace(trace);
    expect(p!.notionalUsd).toBe(0.089);
    expect(p!.spent.usd).toBe(0); // the estimate never becomes billed spend
    expect(p!.children[0]!.notionalUsd).toBe(0.059);
  });
});
