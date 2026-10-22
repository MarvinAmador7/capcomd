// The engine for callers that aren't a terminal (`capcomd mcp`): start it when nothing answers, and leave it running.
// Runs outlive the agent session that started them (ADR-018 §2), so the engine is never stopped from here.
import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { RelayError } from "./errors";
import { endpoint } from "./relay";
import { PACKAGE_ROOT, capcomdHome } from "../utils/home";

const up = async (url: string) => fetch(url + "/", { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where an auto-started engine logs, and the marker that says one is starting (so callers don't start two). */
export const engineLog = () => join(capcomdHome(), "engine.log");
const startingMarker = () => join(capcomdHome(), "engine.starting");
const STARTING_FOR_MS = 120_000;

/** The local port of the endpoint, or null when it isn't this machine (then we never start anything). */
export function localPort(url = endpoint()): number | null {
  try {
    const u = new URL(url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) return null;
    return Number(u.port || 6420);
  } catch { return null; }
}

/**
 * Make sure an engine answers at the endpoint: start `capcomd serve` detached when none does (unless
 * CAPCOMD_NO_ENGINE_AUTOSTART=1 or the endpoint is remote), then wait up to `timeoutMs`. A restart on existing
 * state can take ~40s (docs/upstream/rivetkit-cold-restart.md); past the wait this throws a retryable error.
 */
export async function ensureEngine(o: { timeoutMs?: number } = {}): Promise<{ started: boolean; pid?: number }> {
  const url = endpoint();
  if (await up(url)) return { started: false };
  const port = localPort(url);
  if (port === null || process.env.CAPCOMD_NO_ENGINE_AUTOSTART === "1") {
    throw new RelayError("engine_unreachable", `Rivet engine not reachable at ${url}`, "Start it with `capcomd serve` (or `capcomd service install`) and retry.");
  }
  const marker = startingMarker();
  const starting = existsSync(marker) && Date.now() - statSync(marker).mtimeMs < STARTING_FOR_MS;
  let pid: number | undefined;
  if (!starting) {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, String(Date.now()));
    const fd = openSync(engineLog(), "a");
    const child = spawn(process.execPath, [join(PACKAGE_ROOT, "src", "cli", "index.ts"), "serve", "--port", String(port)], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.unref();
    pid = child.pid;
  }
  const deadline = Date.now() + (o.timeoutMs ?? 45_000);
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await up(url)) { rmSync(marker, { force: true }); return { started: !starting, ...(pid ? { pid } : {}) }; }
  }
  const tail = existsSync(engineLog()) ? readFileSync(engineLog(), "utf8").trim().split("\n").slice(-3).join(" | ") : "";
  throw new RelayError("engine_unreachable", `the engine at ${url} is starting but not answering yet`, `Retry in a few seconds (a restart on existing state can take ~40s).${tail ? ` Log: ${engineLog()}: ${tail.slice(0, 300)}` : ""}`, { retryable: true });
}
