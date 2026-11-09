# CHANGELOG

- Lessons a planner states after its run's consolidator started (for example in its final result) are no longer
  lost: once the planner ends, capcomd starts one more consolidator for just those lessons, and its memory change waits
  for your approval like any other. It happens at most once per run; with `context-memory.autoConsolidate` off,
  `capcomd events` shows `consolidator_skipped` with the reason `late_lessons` instead.
- `capcomd status` from a planner now says how many of the run's lessons came after its consolidator started
  (`lessons.late`), and the planner is told to put its own lessons in its result before it spawns the consolidator.

# Spec

Late lessons are consolidated (ADR-025 §5.2, D6a): the kernel records, as each consolidator attempt starts, which agents' capture records it is given (kv `_consolidator/<agentId>`, reserved): those no consolidator of the run that ended done was given. In-VM `status`'s `lessons` adds `late` (the candidates and declared lessons no done consolidator was given) and `consolidators[].key` (additive). `context-memory`'s fallback, once every agent that may spawn the consolidator has ended and a consolidator ended done, starts one follow-up at the run's top for a run with late lessons (key `consolidator-late`, at most one per run), given only those, its branch landed (held) as any consolidator's; after a landing it looks again. Events: `consolidator_started` carries `late: true, consolidator` for it; `consolidator_skipped` adds the reason `late_lessons` (off) (additive).
