# CHANGELOG

- Fixed: the desktop's Team send button couldn't start a run for a worker profile on Docker or boxd. It failed with
  "--profile/--set pick the worker of the built-in recipe; a planner agent picks its own workers". It now starts a run
  of that one agent.
- `capcomd run "<goal>" --profile <name>` (and POST /v1/runs with `profile`) now starts a run of one agent of that
  profile, on any sandbox. The agent works on the goal itself, with no planner splitting it. Its work is checked
  against the project's checks and reviewer, then merged onto the run's goal branch, which is then ready for a pull
  request (`capcomd pr open <runId>`). `--goal-branch`/`--base` name the branch and its base. With `--no-goal-branch`,
  the work merges into the target, and a protected target waits for `capcomd approve`. If the agent fails or its
  work doesn't pass, the run ends failed with the reason. The built-in recipe still takes a worker profile with
  `--recipe --profile <name>`.
