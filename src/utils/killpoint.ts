const KILLPOINT_ENV = process.env.RELAY_KILLPOINT;

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
    process.exit(137);
  }
}

export function resetKillpointCounts(): void {
  killpointCounts.clear();
}

export function getKillpointCount(name: string): number {
  return killpointCounts.get(name) || 0;
}
