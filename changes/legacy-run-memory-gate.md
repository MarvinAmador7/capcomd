# CHANGELOG

- `capcomd run --legacy` and `--recipe` (runs without a planner agent, off by default) no longer merge a task's branch
  that changes `.capcomd/context/`: the task fails its verification with a message saying that memory lands only from
  a consolidator or a person. Run the goal with a planner agent (plain `capcomd run`), whose consolidator lands lessons
  through the memory gate, or commit the change yourself. A branch capcomd can't read is refused too; other branches
  land as before.

# Spec

Runs without a planner agent never land memory (§17.1 `recipe-hierarchical`, ADR-025 §5.3): before `--legacy` or `--recipe` merges a task's branch, or parks it for approval on a protected target, a branch whose diff from where it left the target touches `.capcomd/context/` (the verified commit for `--recipe`; for `--legacy` the tip, which its verifier then lands or fails as moved) is refused as a failed verification naming the consolidator path, whether or not `context-memory` is on; fail-closed when the branch can't be read, nothing refused without a repository. No hook, route or contract shape changes.
