// LIVE (boxd): the claude-code VM allowlist really blocks other hosts. Runs only from a machine
// that can reach boxd (Marvin's Mac): CAPCOMD_BOXD_LIVE=1 BOXD_API_KEY=... bun test tests/agents/egress.live.test.ts
import { test, expect } from "bun:test";
import { BoxdProvider } from "../../src/providers/boxd";
import { AGENT_EGRESS } from "../../src/agents/config";

const live = process.env.CAPCOMD_BOXD_LIVE === "1" && !!process.env.BOXD_API_KEY;

test.skipIf(!live)("claude-code egress: github.com + api.anthropic.com + registries reachable; example.com blocked", async () => {
  const p = new BoxdProvider({ dbPath: ":memory:", keepaliveMs: 0 });
  const { id } = await p.ensure({ idemKey: `egress-live-${Date.now()}`, isolated: true, ttlSeconds: 900, egressAllow: AGENT_EGRESS, labels: { test: "egress" } });
  try {
    await p.waitReady(id, 120_000);
    const code = async (url: string) =>
      (await p.exec(id, ["sh", "-c", `curl -s -o /dev/null -m 15 -w '%{http_code}' ${url} || true`], { timeoutMs: 30_000 })).stdout.trim();
    for (const url of ["https://github.com", "https://api.anthropic.com/v1/models", "https://registry.npmjs.org/", "https://nodejs.org/dist/index.json"]) {
      expect({ url, code: await code(url) }).not.toEqual({ url, code: "000" });
    }
    for (const url of ["https://example.com", "https://pypi.org", "https://statsig.anthropic.com"]) {
      expect({ url, code: await code(url) }).toEqual({ url, code: "000" });
    }
  } finally {
    await p.destroy(id);
    await p.close();
  }
}, 300_000);
