/** The 10 named killpoints of the chaos gate (shared by the serial and fast runners). */
export const KILLPOINTS = [
  "tx.mid",
  "model.after_return.before_commit",
  "merge.before_cas",
  "merge.after_cas.before_event",
  "push.mid",
  "push.after.before_event",
  "vm.create.after_request.before_record",
  "lease.expire.mid",
  "budget.charge.mid",
  "outbox.dispatch.after_send.before_ack",
];
