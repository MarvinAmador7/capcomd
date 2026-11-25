# CHANGELOG

- An agent's pane is no longer blank while capcomd gets it ready. Until its first step, the desktop app's pane and reel
  column show what capcomd is actually doing, with how long it has taken: "Starting the machine…", "Fetching the
  repository…", "Copying the repository…" with a bar and "53% · 56 of 105 MB", "Preparing the workspace…", "Starting
  planner…". The real thread replaces it as soon as the agent writes something. The menu bar's agent rows show the
  same line ("Copying the repository · 53% (56 of 105 MB)").
- For clients: while an agent is being set up, `Agent.activity` has kind `setup` and a `setup` object (`phase`,
  `bytes`, `totalBytes`), sent live on `agent.activity_changed` (capability `agents.setup`).
