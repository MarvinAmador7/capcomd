# CHANGELOG

- `capcomd auth login fx` works on an environment image built before fx was added: the login installs the pinned fx in
  its VM instead of failing with "fx is not installed in the env snapshot".
- `capcomd env build` now builds a new image when fx's pinned version changes, instead of keeping the existing image
  that has no fx. The first `capcomd env build` after updating builds one new image; until then agents keep using the
  current one and install fx as they start.
- A failed `capcomd auth login` now suggests `capcomd doctor` instead of pointing at `capcomd events <runId>`.
