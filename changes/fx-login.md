# CHANGELOG

- New: fx agents can run on your own Vercel account or Grok plan instead of an AI Gateway key. `capcomd auth login fx`
  signs fx in to Vercel (open the URL, confirm the code), `capcomd auth login fx grok` to a SuperGrok or X Premium plan
  (open the URL, paste the code xAI shows back into the terminal). As with Codex, the login happens inside a login
  machine of the sandbox, never on your computer, and is saved as a private login image; give the profile
  `auth: subscription` (`capcomd profiles add fxp --provider fx --auth subscription`). `capcomd auth status` and
  `capcomd auth logout fx` cover it, and `capcomd doctor` checks it. fx's ChatGPT login can't be made this way:
  `capcomd auth login fx codex` refuses it and points to the `codex` provider. See docs/agents.md → fx.
- `GET /v1/logins?provider=fx` lists fx's logins (capability `logins.fx`); the list without `provider` is unchanged.
- Fixed: `capcomd profiles list` showed an fx profile as needing `ANTHROPIC_API_KEY` or a Claude login; it now checks
  `AI_GATEWAY_API_KEY` or the fx login. `capcomd setup --check` no longer counts an fx profile's plan login as Claude's.

# Spec

fx plan logins (§7.3): `describe().logins` (additive; a CLI with several plan logins lists them as `{name, label, egress, refused?}`; `capcomd auth login <provider> [<name>]` makes one, its login VM reaching that login's `egress`, the ledger recording its name as `AuthProfile.login`; one with `refused` is refused before any machine starts), `loginCommand(bin, login?)` (the second argument additive) and the optional `loginCheck(bin, q)` (a shell line whose only output, `{"loggedIn": <boolean>}`, is all that leaves the login VM; false fails the login). agent-fx: no longer `subscription: false`; logins `vercel` (device flow, `$FX_HOME/auth.json`) and `grok` (pasted code, `$FX_HOME/grok-auth.json`), `codex` refused (a browser callback to the login VM's own localhost:1455, no paste step); on a plan login the prelude drops `AI_GATEWAY_API_KEY` and `VERCEL_OIDC_TOKEN`, sets `FX_HOME` and `CAPCOMD_FX_PROVIDER`, and the bridge runs fx on that provider. harness.v1: `GET /v1/logins` takes `provider` (claude, codex or fx) and `Login.provider` gains `fx`, sent only when asked for with `provider=fx` (capability `logins.fx`, additive); `driver` and `DriverOption.provider` stay `claude` or `codex`.
