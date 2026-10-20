import { Engine } from "../chaos/engine";

export const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const CLI = `${REPO}/src/cli/index.ts`;

/**
 * Always start a private engine on a random port with its own data dir. Never reuse whatever
 * listens on :6420: a stale engine from an older checkout silently runs old actor code
 * (seen 2026-10-20: a 4h-old serve made the scope actor fail to start). CAPCOMD_ENDPOINT is
 * set for this process so capcomd() children target the private engine.
 */
export async function ensureEngine(label: string, env: Record<string, string> = {}): Promise<{ stop: () => Promise<void>; endpoint: string }> {
  const { mkdtempSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await testPort();
    const dataDir = mkdtempSync(join(tmpdir(), `relay-test-${label}-`));
    const engine = new Engine(`test-${label}-${port}`, { port, dataDir, env });
    try {
      await engine.start(null);
    } catch (e) { lastErr = e; await engine.stop().catch(() => {}); continue; }
    const endpoint = `http://127.0.0.1:${port}`;
    const prev = process.env.CAPCOMD_ENDPOINT;
    process.env.CAPCOMD_ENDPOINT = endpoint;
    return { endpoint, stop: async () => { await engine.stop(); if (prev === undefined) delete process.env.CAPCOMD_ENDPOINT; else process.env.CAPCOMD_ENDPOINT = prev; } };
  }
  throw lastErr;
}

/**
 * A free port block for a private engine: the engine binds port, port+1 (api-peer) and
 * port+10 (metrics). Fixed per-file ports overlapped (e2e 7661+10 = verify-merge 7671,
 * verify-merge 7671+10 = state-e2e 7681, and any 7660 engine holds e2e's 7661), which is
 * the 2/20 primitives flake. Blocks are 20 apart in 20000-59999 and checked before use.
 */
export async function testPort(): Promise<number> {
  const { createServer } = await import("net");
  const free = (port: number) => new Promise<boolean>((res) => {
    const srv = createServer().once("error", () => res(false)).once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
  for (let i = 0; i < 50; i++) {
    const base = 20000 + Math.floor(Math.random() * 2000) * 20;
    if ((await free(base)) && (await free(base + 1)) && (await free(base + 10))) return base;
  }
  throw new Error("no free engine port block");
}

export async function capcomd(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
