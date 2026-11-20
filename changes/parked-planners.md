# CHANGELOG

- A planner or lead now wakes in a moment when you message it after its turn ended. Its machine is parked instead of
  deleted (boxd hibernates it and bills only its disk; Docker stops the container), and a message wakes that same
  machine and resumes the same conversation there, with its checkout as it left it. Workers' machines are still deleted
  when they finish. If a parked machine is gone or won't wake, the agent quietly gets a fresh machine with its
  conversation restored, as before.
- Parked machines are deleted after 24 hours by default. Change it per place in Settings › Machines › "Keep parked
  machines for" (4 hours, 24 hours or 7 days); each run keeps the value it started with. They are also deleted when
  more than 10 are parked at a place (the oldest first), when the run is archived (its conversations stay, so a restored
  run picks up where it was) or when the agent is cancelled. `CAPCOMD_PARKED_RETENTION_SECONDS` overrides the setting.
- Settings › Machines lists parked machines as "parked · deletes at …". Delete removes only the machine: the agent stays
  idle and a message to it starts on a fresh machine.
- For clients: capability `agents.park`. `GET /v1/sandboxes/{name}/resources` lists parked machines with state `parked`,
  their agent as owner and `deleteAfter`; their only action is `delete`, which deletes the machine and leaves the agent
  idle (`sandbox.resource_action` carries `parked: true`). Places have a `parkedRetention` setting and `caps.hibernate`
  (`memory`, `disk` or `none`). `sandbox.resource_deleted` has new causes `retention` and `parked_limit`.

# Spec

With parked machines (ADR-026 §6): §7.2's sandbox seam gains `caps.hibernate` (`memory`, `disk` or `none`; absent means `none`) and the optional `hibernate(id, c)` and `wake(id, c)`, present exactly when `caps.hibernate` is `memory` or `disk` (boxd hibernates, never pauses; Docker stops); a provider's descriptor may list the `parkedRetention` setting; the conformance suite checks that a parked machine keeps its files across `hibernate` and `wake`.
