# CHANGELOG

- A task added to a run's board (`capcomd task add`, an agent's in-VM `capcomd task add`, the MCP driver's task tool or
  a plugin's `ctx.board.add`) now has its title checked as a run's goal is: at most 16 KB (UTF-8), no NUL character, and
  not blank. Anything else is refused with a usage error (`invalid` for a plugin) instead of being stored; put long
  detail in a file in the repository, or in `--data`, and name it in the title.

# Spec

A board task's goal is capped like a run's (§8.4 `board`): not blank, at most 16 KB of UTF-8 as given (a task keeps its goal untrimmed), no NUL; `ctx.board.add` refuses anything else `invalid` before the run is looked up, and the in-VM and operator `capcomd task add` refuse it as `usage`. No hook, seam, route or contract shape changes.
