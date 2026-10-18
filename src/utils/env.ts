// Env lookup for capcomd. CAPCOMD_<NAME> wins; RELAY_<NAME> is a deprecated alias
// kept for compatibility (one stderr warning per name, never on stdout so --json/MCP stay clean).
const warned = new Set<string>();

export function env(name: string, source: Record<string, string | undefined> = process.env): string | undefined {
  const v = source[`CAPCOMD_${name}`];
  if (v !== undefined) return v;
  const legacy = source[`RELAY_${name}`];
  if (legacy !== undefined && source === process.env && !warned.has(name) && !process.env.CAPCOMD_NO_DEPRECATION_WARNINGS) {
    warned.add(name);
    process.stderr.write(`capcomd: RELAY_${name} is deprecated; use CAPCOMD_${name}\n`);
  }
  return legacy;
}
