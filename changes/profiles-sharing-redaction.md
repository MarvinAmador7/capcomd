# CHANGELOG

- Fixed: a profile's `sharing.source` no longer shows a URL's credentials. A source written as
  `https://user:token@host/repo` (or with `?token=…` in it) is now shown as `https://host/repo` in
  `capcomd profiles list --json`, `capcomd profiles show` (text and `--json`), the `capcomd_profiles` tool a driver
  agent reads and `GET /v1/profiles/{name}`; before, the list, `show` and `capcomd_profiles` showed it as written, and
  the API row hid only the password. The profile's file is unchanged.

# Spec

A profile's `sharing.source` is shown without a URL's credentials wherever it is served (ADR-024 §7 step 4 and "Made while building the writes"; from a review): `capcomd_profiles`, `capcomd profiles list --json` and `show --json` (`sharing.source`, and `show`'s `values`) and `GET /v1/profiles/{name}`'s rows outside the catalog take out a URL's whole userinfo (`user:password@`, or a token standing as the user, where the row before replaced only the password with `[REDACTED]`) and each query or fragment `name=value` whose name says it is a credential (a `SECRET_KEY` name, `signature`, `credential`, `key`, `sig`, `auth`, `pass`, `pwd`), as well as the redactor's token shapes. No contract, hook, seam or route change.
