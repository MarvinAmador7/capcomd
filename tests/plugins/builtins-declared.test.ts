// The built-in plugins register every contribution their manifests declare, whatever their settings (plugin API §4.7):
// a declaration never registered is a warning the host writes at every start, which the daemon's log showed for
// forge-github (no GitHub repositories as trigger sources) and source-schedule (no schedules) on every start. Each
// listener that only matters under some settings is registered anyway and does nothing without them.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { PluginHost } from "../../packages/plugin/src/host/host";
import type { PluginContext } from "../../packages/plugin/src/context";
import type { HookCall } from "../../packages/plugin/src/hooks";
import { samplePayload, testkit } from "../../packages/plugin/src/testkit";
import { loadManifest } from "../../packages/plugin/src/load";
import { BUILTINS, candidateOf } from "../../src/plugins/builtins";
import { REFRESH_LABEL, sandboxBoxd } from "../../src/plugins/builtin/sandbox-boxd";
import { SOURCE_TIMER, startGitHubSource } from "../../src/plugins/forges/github-source";
import { setGitHubApi } from "../../src/plugins/forges/github-rest";
import * as templates from "../../src/env/templates";
import { VERSION } from "../../src/utils/self";

// A refresh's first step asks whether the daemon keeps project templates: counted here, and always "no", so a refresh
// that runs touches nothing.
let refreshes = 0;
mock.module("../../src/env/templates", () => ({ ...templates, keepsProjectTemplates: () => { refreshes++; return false; } }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A fired timer of `plugin` labelled `label`, as job.changed tells it. */
function fired(plugin: string, label: string) {
  const p = samplePayload("job.changed");
  return { ...p, job: { ...p.job, plugin, spec: { ...p.job.spec, label } }, change: { kind: "fired" as const, n: 1 } };
}

const endpoint = process.env.CAPCOMD_ENDPOINT;
const refresh = process.env.CAPCOMD_TEMPLATE_REFRESH_HOURS;
afterEach(() => {
  setGitHubApi(null);
  if (endpoint === undefined) delete process.env.CAPCOMD_ENDPOINT; else process.env.CAPCOMD_ENDPOINT = endpoint;
  if (refresh === undefined) delete process.env.CAPCOMD_TEMPLATE_REFRESH_HOURS; else process.env.CAPCOMD_TEMPLATE_REFRESH_HOURS = refresh;
});

/** The warnings a host with every built-in (the ones a person turns on too) writes as it starts them with no settings. */
async function startWarnings(): Promise<string[]> {
  // Nothing here may ask a running daemon.
  process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9";
  const logs: Array<{ plugin: string; level: string; message: string }> = [];
  const host = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: () => "/nonexistent", sinks: { log: (l) => { logs.push(l); } } });
  try {
    await host.start(BUILTINS.map((b) => ({ ...candidateOf(b), enabled: true })));
  } finally {
    await host.stop();
  }
  return logs.filter((l) => l.level === "warn").map((l) => `${l.plugin}: ${l.message}`);
}

describe("built-ins register what they declare (§4.7)", () => {
  test("no built-in is warned about a declaration it never registered, with no settings", async () => {
    expect((await startWarnings()).filter((w) => w.includes("declared but never registered"))).toEqual([]);
  });

  test("forge-github with no source repositories, source-schedule with no schedules, sandbox-boxd with the refresh off", async () => {
    process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9";
    process.env.CAPCOMD_TEMPLATE_REFRESH_HOURS = "0";
    for (const name of ["forge-github", "source-schedule", "sandbox-boxd"]) {
      const b = name === "sandbox-boxd" ? sandboxBoxd : BUILTINS.find((x) => (x.manifest as { name: string }).name === name)!;
      const m = loadManifest(b.manifest);
      if (!m.ok) throw new Error(JSON.stringify(m.issues));
      await testkit.loadDispose(m.manifest, b.module as never);
    }
  });
});

describe("a listener registered without its settings does nothing", () => {
  test("forge-github calls GitHub on its timer only for a configured repository or a thread a run follows", async () => {
    // Its timer runs in the daemon whatever is configured (a goal branch's pull request is followed once it is open,
    // §16.3.6); with nothing to read, a fire reads only the subscriptions, and GitHub is never asked.
    let asked = 0;
    let listener: ((call: HookCall<"job.changed">) => void) | undefined;
    let followed: Array<{ runId: string; source: string; thread: string; until: null }> = [];
    setGitHubApi({ listIssueComments: async () => { asked++; return []; } } as never);
    const ctx = {
      plugin: { name: "forge-github" }, hooks: { on: (_: string, f: typeof listener) => { listener = f; } }, log: { warn: () => {} },
      jobs: { list: async () => [], cancel: async () => {} },
      triggers: { subscriptions: async () => followed, onReply: () => ({ dispose() {} }) },
      storage: { get: async () => ({ since: "2026-11-01T00:00:00Z" }), put: async () => {} },
    } as unknown as PluginContext<unknown>;
    const cfg = { api: "http://127.0.0.1:9", sourceRepos: [] as string[], sourceEveryMs: 60_000, sourceCommand: "/capcomd" };
    startGitHubSource(ctx, cfg);
    listener!({ payload: fired("forge-github", SOURCE_TIMER) } as HookCall<"job.changed">);
    await sleep(100);
    expect(asked).toBe(0);
    // A run follows a pull request's thread: the same fire reads its repository.
    followed = [{ runId: "run-1", source: "github", thread: "acme/app#3", until: null }];
    listener!({ payload: fired("forge-github", SOURCE_TIMER) } as HookCall<"job.changed">);
    for (let i = 0; i < 40 && asked < 1; i++) await sleep(25);
    expect(asked).toBe(1);
    // And a configured repository, with nothing followed.
    followed = [];
    startGitHubSource(ctx, { ...cfg, sourceRepos: ["acme/app"] });
    listener!({ payload: fired("forge-github", SOURCE_TIMER) } as HookCall<"job.changed">);
    for (let i = 0; i < 40 && asked < 2; i++) await sleep(25);
    expect(asked).toBe(2);
  });

  test("sandbox-boxd refreshes nothing with the refresh off, though its timer (kept across restarts) fires", async () => {
    process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9";
    const fire = async (hours: string) => {
      process.env.CAPCOMD_TEMPLATE_REFRESH_HOURS = hours;
      const host = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: () => "/nonexistent", sinks: { log: () => {} } });
      try {
        await host.start([{ source: "builtin", manifest: sandboxBoxd.manifest, module: sandboxBoxd.module, enabled: true } as never]);
        host.hooks.fire("job.changed", "observe", fired("sandbox-boxd", REFRESH_LABEL), { principal: { kind: "operator", clientId: null }, entity: "job-test1#fired1", runId: null });
        for (let i = 0; i < 20 && !refreshes; i++) await sleep(25);
      } finally {
        await host.stop();
      }
    };
    await fire("0");
    expect(refreshes).toBe(0);
    // With the refresh on, the same fire refreshes.
    await fire("24");
    expect(refreshes).toBe(1);
  });
});
