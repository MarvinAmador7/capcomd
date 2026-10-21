const GONE = new Set(["destroyed", "deleted", "failed", "deleting"]);

/** Leak = a boxd machine with one of the run's VM names (or a recorded id) that is not gone. */
export function cleanupVerdict(machines: Array<{ id: string; name: string; state: string }>, names: string[], vmId?: string | string[] | null) {
  const ids = new Set(([] as Array<string | null | undefined>).concat(vmId).filter((x): x is string => !!x));
  const matches = machines.filter((m) => names.includes(m.name) || ids.has(m.id));
  return { matches, leaked: matches.some((m) => !GONE.has(m.state)) };
}

/**
 * VM idempotency keys of a run: each worker actor's recorded key, else the key it would derive
 * (`relay-<run[0:8]>-<workerId>-e1`). Workers are the legacy `<run>-worker-1` and one per agent.
 */
export function runVmKeys(runId: string, workers: Array<{ workerId: string; context?: { idemKey?: string; vmId?: string } | null }>) {
  const keys = new Set<string>(), vmIds: string[] = [];
  for (const w of workers) {
    keys.add(`relay-${runId.substring(0, 8)}-${w.workerId}-e1`);
    if (w.context?.idemKey) keys.add(w.context.idemKey);
    if (w.context?.vmId) vmIds.push(w.context.vmId);
  }
  return { keys: [...keys], vmIds };
}
