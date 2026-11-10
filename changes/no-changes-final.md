# CHANGELOG

- A worker that ends without changing any files now fails after its first attempt instead of being run again (up to
  three times) to the same end. Its result keeps what it said (`result.summary`, with `result.errorKind: "no_changes"`),
  and the error says what to do: spawn it with `--report` for work that changes no files. The orchestration skill tells
  planners and leads to spawn investigation and review-only children with `--report`.

# Spec

A worker that changed nothing isn't retried (§16.1, a fix from the live re-check): an agent that may not spawn and wasn't spawned with `report` and ends with no change of its own fails `no_changes` after that one attempt (one `DRIVE_FAILED`), with `result.errorKind: "no_changes"` (additive), an `error` ending `spawn it with --report for work that changes no files`, and its final message as its `summary` when it declared none. The orchestration skill tells a spawner to spawn investigation and review-only children with `--report`. No hook, route or contract shape changes.
