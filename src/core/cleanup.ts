const GONE = new Set(["destroyed", "deleted", "failed", "deleting"]);

/** Leak = a boxd machine with one of the run's VM names (or its recorded id) that is not gone. */
export function cleanupVerdict(machines: Array<{ id: string; name: string; state: string }>, names: string[], vmId?: string | null) {
  const matches = machines.filter((m) => names.includes(m.name) || (!!vmId && m.id === vmId));
  return { matches, leaked: matches.some((m) => !GONE.has(m.state)) };
}
