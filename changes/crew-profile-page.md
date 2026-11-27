# CHANGELOG

- A profile's page in the app can show its recent work: `GET /v1/profiles/{name}/work` lists that profile's latest
  agents (with `?repo=`, in that project's runs), newest first, each with its run, project, title and an outcome
  capcomd reads from its state and its verify, review and merge results: running, idle, merged, passed, found issues,
  failed or cancelled (capability `profiles.work`).
- A profile's persona (its `SOUL.md`) can be read and edited from the app: `GET` and `PUT /v1/profiles/{name}/persona`
  (capability `profiles.persona`; writing needs the `configure` scope). Editing a profile that has no persona gives it
  a `SOUL.md` in its own directory (a single `<name>.yaml` becomes `<name>/profile.yaml`) and bumps its version. A
  project persona you edit needs `capcomd profiles trust <name>` again before its agents get it. Installed packages,
  `agents.json` entries and personas set by an `override.yaml` stay read-only, and the API says why.
- Every agent of a profile can have the same bot face: set `identity.avatar.seed` in the profile (or from the app,
  through `PUT /v1/profiles/{name}`), and `GET /v1/profiles`, each agent and `agent.spawned` carry it as
  `avatarSeed` (capability `profiles.avatar`).
- `POST /v1/runs` takes `planner`, the profile that plans the run, as `capcomd run --planner <name>` does: one of the
  planners `GET /v1/run-options` lists (capability `runs.planner`).

# Spec

With the app's Crew screen (ADR-024 §5; all additive): capability `profiles.work` (`GET /v1/profiles/{name}/work`, a profile's latest agents with a daemon-written outcome), `profiles.persona` (`GET` and `PUT /v1/profiles/{name}/persona`: the one route that serves a persona's text; the PUT is one more `configure`-scope profile write, §11.1, audited by `profile.changed` with `persona` set and never the text), `profiles.avatar` (`avatarSeed`, the profile's `identity.avatar.seed`, on `GET /v1/profiles` rows, which `profiles.list` maps to, and on harness.v1 `Agent` and `agent.spawned`; the plugin `Agent` shape, §3.1, is unchanged) and `runs.planner` (`POST /v1/runs` `planner`).
