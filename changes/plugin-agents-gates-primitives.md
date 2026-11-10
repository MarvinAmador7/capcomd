# CHANGELOG

- Plugins in the daemon can now spawn, await, budget and name agents (`ctx.agents.spawn`, `await`, `grant`, `title`)
  and verify and merge their work (`ctx.gates.verify`, `merge`). A plugin is held to the same checks as any caller: its
  spawn goes through the spawn limits and every `agent.spawning` listener, and its merge needs a passing verification
  and every merge gate, so a plugin's veto is never bypassed (a protected target waits for a person). What a plugin
  does is recorded as `plugin:<name>`'s: `agent.spawned` carries `by`, a verification's and a merge's record carry
  `requester`.
- The memory fallback (`context-memory`'s `autoConsolidate`) now starts the consolidator and asks to verify and merge
  its change as `plugin:context-memory`, not as the operator, so the run's events say who did it.

# Spec

The agents and gates primitives (§8.2, §8.4, §9.6): `agents.spawn`, `await`, `grant`, `title` and `gates.verify`, `merge` answer in the daemon's host (`src/plugins/services.ts`), on the kernel's own operations with the plugin as the caller. `agents.spawn` passes `spawnChecks`, `checkSpawn` and `agent.spawning` (told the plugin's principal) as any caller; `operator`, `review` and the host-only contract keys are `forbidden`; `agent.spawned` carries an additive `by: plugin:<name>`, and `SpawnInput` an optional `title`. `agents.await` reads `timeoutMs` (default 30 000, at most an hour) and answers `{ended, pending}`; `agents.grant` carves from the parent's (or the run's) remainder, never the run's own budget; `agents.title` sets `by: driver`, `setBy: plugin:<name>`. `gates.verify` takes a named check only (`checks` is `forbidden`); `gates.merge` refuses `operator` (`forbidden`), always asks every `merge.landing` gate and parks a protected target's merge for a person; each record keeps `requester: plugin:<name>` (on `verify.started`, `merge.started`), and the hooks they fire are told the plugin asked (`principalOf` maps `plugin:<name>` to a plugin principal, its scopes not recorded). A key is the plugin's own (§8.2). Protocol v1 keeps `agents.spawn/await/grant` and `gates.verify/merge` in process only. `context-memory`'s fallback (ADR-025 D6a) spawns, verifies and merges through these, so they are `plugin:context-memory`'s; its consolidators' recorded keys are the plugin's own (`plugin:context-memory:consolidate`, `plugin:context-memory:consolidator-late`), and it still knows a bare `consolidator-late` from an older run as the follow-up.
