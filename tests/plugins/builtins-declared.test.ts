// The built-in plugins register every contribution their manifests declare, whatever their settings (plugin API §4.7):
// a declaration never registered is a warning the host writes at every start, which the daemon's log showed for
// forge-github (no GitHub repositories as trigger sources) and source-schedule (no schedules) on every start. Each
// listener that only matters under some settings is registered anyway and does nothing without them.
import { afterEach, describe, expect, test } from "bun:test";
import { PluginHost } from "../../packages/plugin/src/host/host";
import { testkit } from "../../packages/plugin/src/testkit";
import { loadManifest } from "../../packages/plugin/src/load";
import { BUILTINS, candidateOf } from "../../src/plugins/builtins";
import { sandboxBoxd } from "../../src/plugins/builtin/sandbox-boxd";
import { VERSION } from "../../src/utils/self";

const endpoint = process.env.CAPCOMD_ENDPOINT;
const refresh = process.env.CAPCOMD_TEMPLATE_REFRESH_HOURS;
afterEach(() => {
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
