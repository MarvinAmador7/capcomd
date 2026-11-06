---
name: capcomd-context-routing
description: What is worth remembering past your task and where it goes, notes for the run in kv and candidate lessons for later runs in your result.
---

# What to remember, and where (capcomd)

Your profile keeps project memory under `.capcomd/context/`. Most of what you learn belongs only in your work; keep
the rest small and put it where it belongs.

- Notes for this run (your plan, what you tried, a finding another agent of the run needs): `capcomd kv put
  notes/<your agent id> '<json>'`, or `capcomd kv cas` to update them. Every agent of the run can read them, and they
  end with the run: anything likely to be out of date within a week goes here and nowhere else.
- A lesson for later runs goes in your result's data: `capcomd result --summary "…" --data
  '{"context":[{"type":"lesson","title":"…","text":"…"}]}'`. It is a candidate: nothing you write reaches the
  project's memory without a review, and you don't edit `.capcomd/context/` for it.
- Write a lesson as a declarative fact about the project ("the nightly export calls isActive in src/customers.js"),
  not as an instruction to yourself or anyone ("always run the export"). Say what failed, what avoided it and where
  you saw it.
- How to do a kind of task is a procedure: it belongs in a skill, not in memory. Say so in your summary instead.
- Don't record what the repository, its AGENTS.md or CLAUDE.md, or your brief already says, and never a secret, a
  token, a credential, personal data or a transcript.
- One lesson per item, a few at most per run. If nothing you learned would change how the next agent works, write none.
