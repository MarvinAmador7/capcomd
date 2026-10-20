import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classify, type Timed } from "./classify";

const base = (o: Partial<Timed>): Timed => ({ ok: true, start: 0, end: 10, phases: { restart: 100, resume: 10 }, ...o });

describe("chaos failure classification", () => {
  test("runtime error with >=3 slow overlapping peers is host-stall", () => {
    const rs = [
      base({ ok: false, error: "Actor x stopped during waiting_for_response_start _stopped_while_waiting" }),
      ...[1, 2, 3].map(() => base({ phases: { restart: 1000 } })),
      ...Array.from({ length: 6 }, () => base({})),
    ];
    expect(classify(rs)[0]).toEqual({ outcome: "host-stall", slowPeers: 3 });
  });
  test("runtime error without a concurrent stall stays a failure", () => {
    const rs = [base({ ok: false, error: "actor_ready_timeout" }), base({ phases: { restart: 1000 } }), ...Array.from({ length: 6 }, () => base({}))];
    expect(classify(rs)[0]!.outcome).toBe("fail");
  });
  test("non-runtime error stays a failure even inside a stall", () => {
    const rs = [base({ ok: false, error: "audit: 2 pushes for key k" }), ...[1, 2, 3, 4].map(() => base({ phases: { restart: 1000 } })), ...Array.from({ length: 6 }, () => base({}))];
    expect(classify(rs)[0]!.outcome).toBe("fail");
  });
  test("slow peers must overlap in time", () => {
    const rs = [base({ ok: false, error: "engine not ready" }), ...[1, 2, 3].map(() => base({ start: 50, end: 60, phases: { restart: 1000 } })), ...Array.from({ length: 6 }, () => base({}))];
    expect(classify(rs)[0]!.outcome).toBe("fail");
  });
  test("replay of the 205/207 stall run classifies both failures as host-stall", () => {
    const log = readFileSync(new URL("../../docs/evidence/chaos-fast-step2-run2-hoststall.log", import.meta.url), "utf8");
    const rs: Timed[] = [];
    for (const m of log.matchAll(/^\[([\d.]+)s\] (✓|✗) .*? (\d+)ms \[up=(\S+) first=(\S+) stop=\S+ restart=(\S+) resume=(\S+) audit=\S+\](.*)$/gm)) {
      const end = Number(m[1]) * 1000, n = (x: string) => (x === "-" ? undefined : Number(x));
      rs.push({ ok: m[2] === "✓", error: m[8], end, start: end - Number(m[3]), phases: { engineUp: n(m[4]!), firstClient: n(m[5]!), restart: n(m[6]!), resume: n(m[7]!) } });
    }
    expect(rs.length).toBe(207);
    const v = classify(rs);
    expect(v.filter((x) => x.outcome === "fail")).toHaveLength(0);
    expect(v.filter((x) => x.outcome === "host-stall")).toHaveLength(2);
  });
});
