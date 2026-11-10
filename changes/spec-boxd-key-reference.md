# Spec

Secrets (§10.3) say how the boxd plugin gets its key today: `sandbox-boxd`'s `apiKey` defaults to `env:BOXD_API_KEY`, which the daemon fills at start from the OS keychain or the credentials file `capcomd setup` keeps (`applyConfig`, only while `BOXD_API_KEY` is unset or empty); no config migration maps the keychain entry to a `keychain:` reference, and a `keychain:` reference for it, from the user layer or the plugin's environment variable, still answers `unsupported`, the provider falling back to `BOXD_API_KEY`. Text only: no hook, seam, route, config or harness contract change.
