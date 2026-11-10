# CHANGELOG

- **Breaking:** a plugin secret reference you set that doesn't resolve is now refused instead of being replaced.
  If you point the boxd plugin's key at a variable (`plugins.sandbox-boxd.apiKey` set to
  `{"$secret": "env:MY_BOXD_KEY"}` in `~/.capcomd/config.json`, or `CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY`) and that
  variable isn't set, capcomd no longer falls back to `BOXD_API_KEY`, which could be another boxd account's key.
  The boxd place shows as unavailable, and runs on it, `capcomd doctor` and `capcomd sandbox` stop with a message
  that names the reference and how to fix it. `capcomd plugins show` and `capcomd plugins validate` print the same
  message. To fix it, export the variable where capcomd runs (for the service, run `capcomd service restart` after
  you set it), or remove the setting to use `BOXD_API_KEY` as before. If you never set `apiKey`, nothing changes.
- **Breaking:** `keychain:` secret references are refused when capcomd loads your config. Before, they failed when
  first used, or the boxd plugin quietly used `BOXD_API_KEY` instead. Now a plugin with one in your config, a
  project's config, a `CAPCOMD_PLUGIN_*` variable or its own manifest fails with `config_invalid`, and the message
  says to use `{"$secret": "env:<VAR>"}` instead. Put the value in an environment variable and reference that.

# Spec

Secret references fail closed (§10.3, §10.4; owner decisions 2026-11-10): a reference the user set (the user layer's or `CAPCOMD_PLUGIN_<NAME>_<KEY>`'s) whose variable is unset or empty, or a value there that isn't a reference, is refused as `config_invalid` when it is resolved, with a message that names the reference and the fix (`ctx.config.secret` still rejects `not_found`, or `invalid` for a non-reference), and nothing stands in for it: sandbox-boxd no longer falls back to `BOXD_API_KEY`, so its place is unavailable with that reason (`available()`, `GET /v1/sandboxes`, the preflight), whatever makes its provider fails with it (exit 2, reason `config_invalid`), and `capcomd plugins show` (`refusedSecrets` in `--json`, additive) and `capcomd plugins validate` (an issue at `plugins.<name>.<key>`) print it; the default reference, nothing set, works as before. `keychain:<account>` references stay unbuilt and are `config_invalid` when the config is loaded, from any layer (user, project, env, a manifest's default, a built-in's included), with the hint to use `env:<VAR>`; `capcomd plugins validate <dir>` reports a keychain default; which keychain service they read stays open, decided when they are built. No hook, seam or harness contract shape changes.
