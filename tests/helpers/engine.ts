import { Engine } from "../chaos/engine";

export const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const CLI = `${REPO}/src/cli/index.ts`;

async function reachable(): Promise<boolean> {
  try {
    await fetch("http://127.0.0.1:6420/", { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/** Use a running engine on :6420, or start one for the duration of the file. */
export async function ensureEngine(label: string): Promise<{ stop: () => Promise<void> }> {
  if (await reachable()) return { stop: async () => {} };
  const engine = new Engine(`test-${label}`);
  await engine.start(null);
  return { stop: () => engine.stop() };
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
