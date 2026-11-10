# CHANGELOG

- A plugin's `agent.spawning` patch that adds `budget` or `children` to an agent's contract now refuses the spawn
  (`invalid`) instead of being saved with the agent and never applied. To lower an agent's budget or narrow its
  fan-out, a plugin sets the patch's own `budget` and `grant`.

# Spec

`agent.spawning` (§6.6.6): a patch's `contract` that adds `budget` or `children` is `invalid` (hint `use the patch's budget and grant`), since both are read into the spawn's budget and grant before the hook and one a plugin added would be recorded but never applied; the spawner's own, repeated unchanged, is still allowed, and a changed one is still `widening`. No hook, seam, route or contract shape changes.
