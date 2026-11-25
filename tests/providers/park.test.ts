// ADR-026 §6: the fake provider parks machines when asked to (CAPCOMD_FAKE_HIBERNATE=1, as boxd and Docker do), the
// machines ledger records a parked machine for its next attempt to find, and the seam carries hibernate and wake
// exactly when a place's caps say it parks machines.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../../src/providers/fake";
import { SandboxNotFoundError } from "../../src/providers/boxd-errors";
import { machineNameFor, parkedMachines, readMachineLedger, recordAgentMachine, recordParked } from "../../src/providers/machines";
import { hibernateCap, PROVIDERS } from "../../src/providers/registry";
import { kernelSandbox } from "../../src/providers/seam";
import { sandboxSeam } from "../../src/plugins/sandboxes";
import { parkable } from "../../src/primitives/park";

const spec = (k: string) => ({ idemKey: `relay-park-${k}`, isolated: true as const, ttlSeconds: 600, egressAllow: ["*"], labels: {} });

describe("FakeProvider parks machines only when asked to", () => {
  test("off by default: no hibernate or wake (the kernel then destroys machines as before)", () => {
    const p = new FakeProvider();
    expect(p.hibernate).toBeUndefined();
    expect(p.wake).toBeUndefined();
  });

  test("hibernate keeps its files and runs nothing; wake (or ensure with its key) brings it back; a gone one is not_found", async () => {
    const p = new FakeProvider({ hibernate: true });
    const { id } = await p.ensure(spec("a"));
    await p.waitReady(id, 1000);
    await p.upload(id, "/w/session.jsonl", new TextEncoder().encode("{}\n"));
    await p.hibernate!(id);
    expect((await p.list("relay-")).find((v) => v.id === id)?.state).toBe("hibernated");
    await expect(p.exec(id, ["true"])).rejects.toThrow("not ready");
    await p.wake!(id);
    expect((await p.exec(id, ["true"])).code).toBe(0);
    expect(new TextDecoder().decode(await p.download(id, "/w/session.jsonl"))).toBe("{}\n");
    // The same key wakes it too (boxd's and Docker's ensure do), and returns the same machine.
    await p.hibernate!(id);
    expect(await p.ensure(spec("a"))).toEqual({ id, created: false });
    expect((await p.exec(id, ["true"])).code).toBe(0);
    expect(p.parkLog.map((x) => x.op)).toEqual(["hibernate", "wake", "hibernate"]);
    await p.destroy(id);
    await expect(p.wake!(id)).rejects.toBeInstanceOf(SandboxNotFoundError);
    await expect(p.hibernate!("vm-404")).rejects.toBeInstanceOf(SandboxNotFoundError);
  });

  test("an injected fault covers wake (a machine that won't wake)", async () => {
    const p = new FakeProvider({ hibernate: true });
    const { id } = await p.ensure(spec("b"));
    await p.hibernate!(id);
    p.faults = { until: Date.now() + 60_000, error: "not_found", ops: ["wake"] };
    await expect(p.wake!(id)).rejects.toBeInstanceOf(SandboxNotFoundError);
  });
});

describe("the machines ledger's parked records", () => {
  test("recorded on the agent's machine record (its key carried), listed oldest first by place, run or agent; a new record clears it", () => {
    const env = { CAPCOMD_MACHINES_LEDGER: mkdtempSync(join(tmpdir(), "capcomd-parked-")) };
    const base = { sandbox: "boxd", runId: "run-1", workerKey: ["run-1", "agt-a"], ttlSeconds: 3600 };
    recordAgentMachine({ ...base, idemKey: "relay-run-1-agt-a-e1", agentId: "agt-a" }, env);
    expect(parkedMachines({}, env)).toEqual([]);
    expect(recordParked({ ...base, idemKey: "relay-run-1-agt-a-e1", agentId: "agt-a", parked: { at: 2000, deleteAt: 9000, vmId: "m_a", idemKey: "relay-run-1-agt-a-e1" } }, env)).toBe(true);
    // A machine whose record went missing is recorded whole.
    expect(recordParked({ ...base, workerKey: ["run-1", "agt-b"], idemKey: "relay-run-1-agt-b-e1", agentId: "agt-b", parked: { at: 1000, deleteAt: 9000, vmId: "m_b", idemKey: "relay-run-1-agt-b-e1" } }, env)).toBe(true);
    expect(parkedMachines({}, env).map((m) => m.agentId)).toEqual(["agt-b", "agt-a"]);
    expect(parkedMachines({ agentId: "agt-a" }, env)[0]).toMatchObject({ name: machineNameFor("relay-run-1-agt-a-e1"), kind: "agent", workerKey: ["run-1", "agt-a"], parked: { vmId: "m_a", idemKey: "relay-run-1-agt-a-e1" } });
    expect(parkedMachines({ sandbox: "docker" }, env)).toEqual([]);
    expect(parkedMachines({ runId: "run-2" }, env)).toEqual([]);
    // Its next attempt's worker takes it and writes its record anew: no longer parked, still capcomd's.
    recordAgentMachine({ ...base, workerKey: ["run-1", "agt-a", "e2"], idemKey: "relay-run-1-agt-a-e1", agentId: "agt-a" }, env);
    expect(parkedMachines({}, env).map((m) => m.agentId)).toEqual(["agt-b"]);
    expect(readMachineLedger(env)!.map((e) => e.name)).toContain(machineNameFor("relay-run-1-agt-a-e1"));
  });
});

describe("caps.hibernate and the seam", () => {
  test("boxd keeps memory, Docker disk, the fakes park nothing; the seams carry hibernate and wake exactly when they do", () => {
    expect(hibernateCap("boxd")).toBe("memory");
    expect(hibernateCap("docker")).toBe("disk");
    expect(hibernateCap("fake")).toBe("none");
    expect(hibernateCap("nope")).toBe("none");
    for (const name of Object.keys(PROVIDERS)) {
      const seam = sandboxSeam(name)!;
      const parks = hibernateCap(name) !== "none";
      expect(typeof seam.hibernate === "function").toBe(parks);
      expect(typeof seam.wake === "function").toBe(parks);
    }
  });

  test("a plugin's seam with hibernate and wake gives the kernel's provider both", async () => {
    const calls: string[] = [];
    const seam: any = { describe: () => ({ name: "x" }), classifyError: () => ({ kind: "unknown", retryable: false }), hibernate: async (id: string) => { calls.push(`h:${id}`); }, wake: async (id: string) => { calls.push(`w:${id}`); } };
    const p = kernelSandbox(seam);
    await p.hibernate!("m1");
    await p.wake!("m1");
    expect(calls).toEqual(["h:m1", "w:m1"]);
    expect(kernelSandbox({ ...seam, hibernate: undefined, wake: undefined }).hibernate).toBeUndefined();
  });
});

describe("who parks", () => {
  test("a planner or lead (an orchestrate profile, or a root agent); never a worker, a reviewer, a report agent or the consolidator", () => {
    const a = (o: Record<string, unknown>) => ({ parent: null, spec: null, contract: null, profile: "planner", ...o }) as any;
    expect(parkable(a({}))).toBe(true);
    expect(parkable(a({ parent: "agt-p", spec: { toolMode: "orchestrate" } }))).toBe(true);
    expect(parkable(a({ parent: "agt-p", profile: "worker" }))).toBe(false);
    expect(parkable(a({ contract: { review: { sha: "x" } } }))).toBe(false);
    expect(parkable(a({ contract: { report: true } }))).toBe(false);
    expect(parkable(a({ profile: "context-consolidator" }))).toBe(false);
  });
});
