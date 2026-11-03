// The memory cap on local (Docker) agents (src/providers/capacity.ts): slots from Docker's memory and a per-agent
// budget, admission oldest first, slots freed when a machine goes, and the Agents at once row.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { admits, agentMemory, agentSlots, AgentSlots, releaseSlot, slotsFor } from "../../src/providers/capacity";
import { agentSlotsField } from "../../src/api/sandboxes";

const GB = 1024 ** 3;

describe("the arithmetic", () => {
  test("slots: memory over the budget, rounded down, at least one", () => {
    expect(agentSlots(8 * GB, 1024)).toBe(8);
    expect(agentSlots(7.76 * GB, 1024)).toBe(7);
    expect(agentSlots(8 * GB, 512)).toBe(16);
    expect(agentSlots(8 * GB, 3072)).toBe(2);
    expect(agentSlots(0.5 * GB, 1024)).toBe(1);
  });
  test("admits: the slots in use plus the agents ahead must leave one free", () => {
    expect(admits({ slots: 2, used: 1, ahead: 0 })).toBe(true);
    expect(admits({ slots: 2, used: 2, ahead: 0 })).toBe(false);
    expect(admits({ slots: 2, used: 1, ahead: 1 })).toBe(false);
  });
  test("the budget: the environment wins, then the user config, then 1 GB; nonsense is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-cap-"));
    const cfg = join(dir, "config.json");
    expect(agentMemory({}, null)).toEqual({ mb: 1024, source: "default" });
    writeFileSync(cfg, JSON.stringify({ sandboxes: { docker: { agentMemory: 2048 } } }));
    expect(agentMemory({}, cfg)).toEqual({ mb: 2048, source: "config" });
    expect(agentMemory({ CAPCOMD_DOCKER_AGENT_MEMORY_MB: "512" }, cfg)).toEqual({ mb: 512, source: "env" });
    expect(agentMemory({ CAPCOMD_DOCKER_AGENT_MEMORY_MB: "12" }, null)).toEqual({ mb: 1024, source: "default" }); // under the minimum
    expect(agentMemory({ CAPCOMD_DOCKER_AGENT_MEMORY_MB: "1g" }, null)).toEqual({ mb: 1024, source: "default" });
    writeFileSync(cfg, "{not json");
    expect(agentMemory({}, cfg)).toEqual({ mb: 1024, source: "default" });
  });
});

describe("AgentSlots", () => {
  const make = (o: { mem?: number | null; running?: string[]; now?: () => number } = {}) => {
    const running = o.running ?? [];
    return { running, slots: new AgentSlots({ memTotal: async () => (o.mem === undefined ? 2 * GB : o.mem), running: async () => running, perAgentMb: () => 1024, now: o.now }) };
  };
  test("two slots: two start, the third waits until one is released, then starts", async () => {
    const { slots } = make();
    expect((await slots.request("a", 1)).admitted).toBe(true);
    expect((await slots.request("b", 2)).admitted).toBe(true);
    const c = await slots.request("c", 3);
    expect(c).toMatchObject({ admitted: false, slots: 2, used: 2, ahead: 0 });
    // Asking again doesn't take another slot.
    expect((await slots.request("a", 1)).admitted).toBe(true);
    slots.release("a");
    expect((await slots.request("c", 3)).admitted).toBe(true);
  });
  test("oldest request first: a later agent doesn't jump the queue when a slot frees", async () => {
    const { slots } = make();
    await slots.request("a", 1); await slots.request("b", 2);
    expect((await slots.request("c", 3)).admitted).toBe(false);
    expect((await slots.request("d", 4)).admitted).toBe(false);
    slots.release("a");
    expect(await slots.request("d", 4)).toMatchObject({ admitted: false, ahead: 1 });
    expect((await slots.request("c", 3)).admitted).toBe(true);
  });
  test("running containers count (agents from before a restart), and one already running is admitted", async () => {
    const { slots, running } = make();
    running.push("x", "y");
    expect((await slots.request("a", 1)).admitted).toBe(false);
    expect((await slots.request("x", 0)).admitted).toBe(true);
    running.splice(0);
    expect((await slots.request("a", 1)).admitted).toBe(true);
  });
  test("an admitted agent whose machine never runs gives its slot back after the grace; Docker not answering admits", async () => {
    let t = 0;
    const { slots } = make({ now: () => t });
    await slots.request("a", 1); await slots.request("b", 2);
    expect((await slots.request("c", 3)).admitted).toBe(false);
    t = 11 * 60_000;
    expect((await slots.request("c", 3)).admitted).toBe(true);
    const down = make({ mem: null }).slots;
    expect(await down.request("a", 1)).toMatchObject({ admitted: true, slots: null });
  });
  test("the budget is read on every request: a change applies to the next agent that asks (nothing cached)", async () => {
    let mb = 1024;
    const slots = new AgentSlots({ memTotal: async () => 2 * GB, running: async () => [], perAgentMb: () => mb });
    await slots.request("a", 1); await slots.request("b", 2);
    expect(await slots.request("c", 3)).toMatchObject({ admitted: false, slots: 2, perAgentMb: 1024 });
    mb = 512;
    expect(await slots.request("c", 3)).toMatchObject({ admitted: true, slots: 4, perAgentMb: 512 });
    // The fakes' slots (and Docker's) read the setting itself each time: here its environment variable.
    const saved = { mem: process.env.CAPCOMD_FAKE_MEMORY_MB, budget: process.env.CAPCOMD_DOCKER_AGENT_MEMORY_MB };
    try {
      process.env.CAPCOMD_FAKE_MEMORY_MB = "2048";
      process.env.CAPCOMD_DOCKER_AGENT_MEMORY_MB = "1024";
      const fake = slotsFor("fake")!;
      expect((await fake.request("budget-a", 1)).slots).toBe(2);
      process.env.CAPCOMD_DOCKER_AGENT_MEMORY_MB = "512";
      expect((await fake.request("budget-b", 2)).slots).toBe(4);
      releaseSlot("budget-a"); releaseSlot("budget-b");
      expect(fake.holds("budget-a") || fake.holds("budget-b")).toBe(false);
    } finally {
      for (const [k, v] of [["CAPCOMD_FAKE_MEMORY_MB", saved.mem], ["CAPCOMD_DOCKER_AGENT_MEMORY_MB", saved.budget]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  test("only Docker has a cap (the cloud doesn't); the fakes only with the test knob", () => {
    expect(slotsFor("docker")).toBeInstanceOf(AgentSlots);
    expect(slotsFor("boxd")).toBeNull();
    expect(slotsFor(null)).toBeNull();
    const saved = process.env.CAPCOMD_FAKE_MEMORY_MB;
    delete process.env.CAPCOMD_FAKE_MEMORY_MB;
    expect(slotsFor("fake")).toBeNull();
    process.env.CAPCOMD_FAKE_MEMORY_MB = "2048";
    expect(slotsFor("fake")).toBeInstanceOf(AgentSlots);
    if (saved === undefined) delete process.env.CAPCOMD_FAKE_MEMORY_MB; else process.env.CAPCOMD_FAKE_MEMORY_MB = saved;
  });
});

test("the Agents at once row: the cap from Docker's memory and the budget, and who set the budget", () => {
  expect(agentSlotsField({ memTotal: 8 * GB, memory: { mb: 1024, source: "default" } })).toMatchObject({ id: "agentSlots", value: "8", display: "8 (8 GB ÷ 1 GB per agent)", source: "daemon", editable: false });
  const env = agentSlotsField({ memTotal: 7.8 * GB, memory: { mb: 1536, source: "env" } });
  expect(env).toMatchObject({ value: "5", display: "5 (7.8 GB ÷ 1.5 GB per agent)", source: "env" });
  expect(env.help).toContain("Set by CAPCOMD_DOCKER_AGENT_MEMORY_MB");
  expect(agentSlotsField({ memTotal: 8 * GB, memory: { mb: 512, source: "config" } })).toMatchObject({ value: "16", display: "16 (8 GB ÷ 512 MB per agent)", help: expect.stringContaining("Change it with Memory per agent.") });
});
