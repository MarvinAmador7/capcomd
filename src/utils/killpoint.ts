import { startSpan, endSpan } from "./tracing-simple";
import { env } from "./env";
const KILLPOINT_ENV = env("KILLPOINT");

let killpointCounts = new Map<string, number>();

export function parseKillpoint(): { name: string; n: number } | null {
  if (!KILLPOINT_ENV) return null;

  const parts = KILLPOINT_ENV.split(":");
  const name = parts[0] || "";
  const n = parts[1] ? parseInt(parts[1], 10) : 1;

  return { name, n };
}

export function killpoint(name: string): void {
  const config = parseKillpoint();
  if (!config || config.name !== name) return;

  const count = (killpointCounts.get(name) || 0) + 1;
  killpointCounts.set(name, count);

  if (count === config.n) {
    console.error(`[KILLPOINT] Exiting at ${name}:${count}`);
    const marker = startSpan(`killpoint.${name}`, { "relay.killpoint": `${name}:${count}` });
    marker.status = { code: 2, message: "process killed by killpoint" };
    if (marker.attributes["relay.run_id"]) endSpan(marker);
    // A killpoint simulates a crash, so die by SIGKILL. process.exit() runs exit
    // hooks and rivetkit's native envoy shutdown. In gate-3 seed 35 that kept the
    // "dead" runner alive ~2 min, and it reconnected to the restarted engine, which then
    // routed actors to a zombie (tunnel_message_timeout / no_responders).
    try { process.kill(process.pid, "SIGKILL"); } catch {}
    process.exit(137); // unreachable unless SIGKILL is unavailable
  }
}

export function resetKillpointCounts(): void {
  killpointCounts.clear();
}

export function getKillpointCount(name: string): number {
  return killpointCounts.get(name) || 0;
}
