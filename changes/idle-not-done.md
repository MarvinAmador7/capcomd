# CHANGELOG

- An agent whose work ended (done, failed or stopped) is now idle, not finished: a message to it (`capcomd send`, the
  app's message box, a parent's message) starts its next turn on a fresh machine, from its own branch or last
  checkpoint, with its thread so far as its context. The send answers `continued: true`. Messages that arrive as an
  attempt ends are never lost: the agent continues at once to read them.
- `capcomd run archive <run>` makes a run read-only: its agents take no messages ("… is archived · restore to
  continue") until `capcomd run restore <run>`. A run can't be archived while an agent in it still works.
- `capcomd send --model <model> --effort <level>` (`model` and `effort` on the messages API) changes what an agent's
  next turns run with. A working agent finishes its current turn first, then continues on the new model; the thread
  shows a "model → … · effort …" line.
- Budgets add up across an agent's turns: turns and spend count every attempt, and wall time counts only while it
  works (not while it is idle or waiting to be woken).
- The desktop app shows a root agent whose turn ended as "idle", a woken one as "waking" (after a second of setup,
  with the new "Restoring the conversation" step), and an archived run's agents as "archived".
- The orchestration skill tells drivers to message an idle child instead of spawning a new one, and to use
  `spawn --continue` for an agent stopped at a limit (`grant` still refuses an ended agent).
- harness.v1: capabilities `agents.idle`, `agents.messages.model` and `runs.archive`; `Agent.continued`,
  `Run.archived`; events `agent.continued`, `agent.model_changed`, `run.archived` and `run.restored`; setup phase
  `restore`; thread item kind `note`; `POST /v1/runs/{id}/archive` and `/restore`. A message to an archived run is
  refused with 409 `archived` (it used to be 409 for an ended agent).
