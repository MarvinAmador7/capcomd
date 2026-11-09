// A place's settings and info rows are its sandbox plugin's UI descriptors (plugin API §4.7.5, §17.1): each built-in
// sandbox plugin registers the rows its descriptor lists, and GET /v1/sandboxes/{name} serves what they read, in the
// descriptor's order. The wire shape of those rows is tests/api/sandboxes.test.ts's, unchanged.
import { afterEach, describe, expect, test } from "bun:test";
import type { UiDescriptor, UiRowValue } from "../../packages/plugin/src/context";
import { ContributionStore } from "../../packages/plugin/src/host/context";
import { agentMemoryField, agentSlotsField, checkpointsField, idleLifetimeField, loginsField, sandboxDetail } from "../../src/api/sandboxes";
import { SANDBOX_BUILTINS } from "../../src/plugins/builtin/sandboxes";
import { rowContributions } from "../../src/plugins/builtin/sandbox-rows";
import { sandboxSeam, sandboxUi, useSandboxHost } from "../../src/plugins/sandboxes";
import { PROVIDERS } from "../../src/providers/registry";
import { memorySettingsStore } from "../../src/providers/settings";

afterEach(() => useSandboxHost(null));

const LOGINS = [{ provider: "claude" as const, sandbox: "docker", loggedIn: true, hostBound: false }, { provider: "codex" as const, sandbox: "boxd", loggedIn: true, hostBound: true }];
const facts = (o: { env?: Record<string, string> } = {}) => ({
  env: o.env ?? {}, logins: LOGINS, idleLifetime: { seconds: 14400, source: "config" as const }, writable: true, slots: { memTotal: 8 * 1024 ** 3 }, store: memorySettingsStore({ docker: { agentMemory: 2048 } }),
});
type Row = Extract<UiDescriptor, { kind: "settings" | "info" }>;

describe("each sandbox plugin contributes its rows", () => {
  test("its manifest declares, and its activation registers, one descriptor per row its descriptor lists", () => {
    for (const b of SANDBOX_BUILTINS) {
      const d = b.descriptor;
      const declared = (b.manifest.contributes as { ui?: Array<{ kind: string; id: string }> }).ui ?? [];
      expect(declared).toEqual([...d.settings.map((id) => ({ kind: "settings", id })), ...d.info.map((id) => ({ kind: "info", id }))]);
      expect(rowContributions(d)).toEqual(declared as never);
      const ui = sandboxUi(d.name);
      expect(ui.builtin).toBe(true);
      expect(ui.descriptors.map((x) => [x.kind, x.id])).toEqual(declared.map((x) => [x.kind, x.id]));
    }
    // Docker's five rows, boxd's three; the fakes have none.
    expect(sandboxUi("docker").descriptors.map((x) => x.id)).toEqual(["idleLifetime", "agentMemory", "logins", "checkpoints", "agentSlots"]);
    expect(sandboxUi("boxd").descriptors.map((x) => x.id)).toEqual(["idleLifetime", "logins", "checkpoints"]);
    expect(sandboxUi("nope")).toEqual({ builtin: false, descriptors: [] });
  });

  test("a descriptor carries the row's fixed parts, and its read the rest of the field", async () => {
    const memory = sandboxUi("docker").descriptors.find((x) => x.id === "agentMemory") as Row;
    expect(memory).toMatchObject({ kind: "settings", label: "Memory per agent", type: "choice", choices: [{ value: "512", label: "512 MB" }, { value: "1024", label: "1 GB" }, { value: "2048", label: "2 GB" }, { value: "4096", label: "4 GB" }] });
    const read = await (memory.read as (f: unknown) => Promise<UiRowValue>)(facts());
    expect(read).toEqual({ value: "2048", display: "2 GB", source: "config", editable: true, help: memory.help, default: "1024", appliesTo: "new_agents", needsRestart: false });
    // A help that depends on the facts is read with them.
    const slots = sandboxUi("docker").descriptors.find((x) => x.id === "agentSlots") as Row;
    expect((await (slots.read as (f: unknown) => Promise<UiRowValue>)(facts())).help).toContain("2 GB each");
  });
});

describe("GET /v1/sandboxes/{name} serves the plugin's rows", () => {
  test("byte for byte the fields the rows always were, in the descriptor's order", async () => {
    const f = facts({ env: { CAPCOMD_AGENT_CHECKPOINT_MS: "300000" } });
    const docker = (await sandboxDetail("docker", f))!;
    const memory = { mb: 2048, source: "config" as const };
    expect(JSON.stringify(docker.settings)).toBe(JSON.stringify([idleLifetimeField(PROVIDERS.docker, f.idleLifetime, true), agentMemoryField(memory, true)]));
    expect(JSON.stringify(docker.info)).toBe(JSON.stringify([loginsField("docker", LOGINS), checkpointsField(f.env), agentSlotsField({ memTotal: f.slots.memTotal, memory })]));
    const boxd = (await sandboxDetail("boxd", f))!;
    expect(JSON.stringify(boxd.settings)).toBe(JSON.stringify([idleLifetimeField(PROVIDERS.boxd, f.idleLifetime, true)]));
    expect(JSON.stringify(boxd.info)).toBe(JSON.stringify([loginsField("boxd", LOGINS), checkpointsField(f.env)]));
    expect(await sandboxDetail("fake", f)).toBeNull();
  });

  test("a row comes from what the plugin registered: one it changes reads changed, one it leaves out isn't served", async () => {
    // The daemon's host, with docker's seam and only some of its rows, one of them its own.
    const store = new ContributionStore();
    store.add("sandbox/docker", "sandbox-docker", { kind: "seam", seam: "sandbox", impl: sandboxSeam("docker")! });
    const real = sandboxUi("docker").descriptors;
    for (const id of ["agentMemory", "logins"]) store.add(`sandbox-docker/${id}`, "sandbox-docker", { kind: "ui", descriptor: real.find((x) => x.id === id)! });
    const mine: Row = { kind: "info", id: "checkpoints", label: "Saved work", help: null, type: "info", read: async () => ({ value: "1", display: "Often", source: "daemon", editable: false }) };
    store.add("sandbox-docker/checkpoints", "sandbox-docker", { kind: "ui", descriptor: mine });
    useSandboxHost({ contributions: store });
    const d = (await sandboxDetail("docker", facts()))!;
    expect(d.settings.map((x) => x.id)).toEqual(["agentMemory"]);
    expect(d.info.map((x) => x.id)).toEqual(["logins", "checkpoints"]);
    expect(d.info[1]).toEqual({ id: "checkpoints", type: "info", label: "Saved work", help: null, value: "1", display: "Often", default: null, choices: [], source: "daemon", editable: false, appliesTo: null, needsRestart: false, state: null });
    // The descriptor still lists every row (the place's data), and the rev covers only the settings served.
    expect(d.descriptor.info).toEqual(["logins", "checkpoints", "agentSlots"]);
  });

  test("only a built-in's rows are given the daemon's facts", async () => {
    const store = new ContributionStore();
    store.add("sandbox/docker", "someone-else", { kind: "seam", seam: "sandbox", impl: sandboxSeam("docker")! });
    const given: unknown[][] = [];
    const row: Row = { kind: "info", id: "logins", label: "Logins", help: null, type: "info", read: async (...a: unknown[]) => { given.push(a); return { value: null, display: "Ask us", source: "daemon", editable: false }; } };
    store.add("someone-else/logins", "someone-else", { kind: "ui", descriptor: row });
    useSandboxHost({ contributions: store });
    expect(sandboxUi("docker").builtin).toBe(false);
    const d = (await sandboxDetail("docker", facts()))!;
    expect(d.info.map((x) => x.display)).toEqual(["Ask us"]);
    expect(given).toEqual([[]]);
  });
});
