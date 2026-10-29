/** The named killpoints of the chaos gate (shared by the serial and fast runners). */
export const KILLPOINTS = [
  "tx.mid",
  "model.after_return.before_commit",
  "merge.before_cas",
  "merge.after_cas.before_event",
  "merge.lock.acquired",
  "merge.after_fetch.before_integrate",
  "push.mid",
  "push.after.before_event",
  "vm.create.after_request.before_record",
  "lease.expire.mid",
  "budget.charge.mid",
];

/**
 * Killpoints exercised on the recipe path (`capcomd run --recipe`, the CLI default), audited
 * with the same invariants (one landing per plan task, ledger, budget). All actor and
 * merge killpoints apply; the recipe adds the scope primitives it composes (claim, spawn).
 * lease.expire.mid is legacy-only: only the legacy loop expires a stale ledger lease on resume.
 */
export const RECIPE_KILLPOINTS = [
  ...KILLPOINTS.filter((k) => k !== "lease.expire.mid"),
  "board.claim.mid",
  "scope.spawn.mid",
];
