# CHANGELOG

- A plugin's `agent.spawning` patch that adds `budget` or `children` to an agent's contract is now rejected as invalid
  instead of being saved with the agent and never applied: a listener declared `failure: closed` refuses the spawn, an
  open one (the default) is skipped and its patch dropped, as for any patch capcomd rejects. To lower an agent's budget
  or narrow its fan-out, a plugin sets the patch's own `budget` and `grant`.

# Spec

`agent.spawning` (§6.6.6): a patch's `contract` that adds `budget` or `children` is `invalid` (hint `use the patch's budget and grant`, also in the message, since a failed call keeps only the message), since both are read into the spawn's budget and grant before the hook and one a plugin added would be recorded but never applied; like every rejected patch it is a failed call (§6.5), refusing the spawn for a `closed` listener and skipped for an `open` one; the spawner's own, repeated unchanged, is still allowed, and a changed one is still `widening`. No hook, seam, route or contract shape changes.
