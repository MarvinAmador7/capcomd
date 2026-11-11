# CHANGELOG

- `capcomd auth login fx` works on an environment image built before fx was added: the login installs the pinned fx in
  its VM instead of failing with "fx is not installed in the env snapshot".
- `capcomd env build` now builds a new image when fx's pinned version changes, instead of keeping the existing image
  that has no fx. The first `capcomd env build` after updating builds one new image; until then agents keep using the
  current one and install fx as they start.
- A failed `capcomd auth login` now suggests `capcomd doctor` instead of pointing at `capcomd events <runId>`.
- The check after `capcomd auth login` runs on the agent's configured model (`CAPCOMD_AGENT_MODEL` or the profile's
  `model`) instead of the CLI's default. For fx on a Vercel Token Pass, log in with a featured model, for example
  `CAPCOMD_AGENT_MODEL=zai/glm-5.3 capcomd auth login fx`. When the account won't pay for the model (no AI Gateway
  credit, or a Token Pass that doesn't cover it), the error says the login itself worked and what to change.

# Spec

Plan logins: a release-archive CLI (fx) missing from the env image is installed in the login VM, which also reaches the
archive's host, and `verifyCommand(bin, q, model)` gains an optional third argument, the agent's configured model.
