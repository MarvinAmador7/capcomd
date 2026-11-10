# CHANGELOG

- Fixed: a merge into GitHub no longer fails on GitHub's own momentary error. When GitHub answers the merge of a pull
  request with a server error (a 500 or similar, seen in a live run), capcomd looks at the pull request again (the merge
  may have happened anyway, and is then recorded as merged) and asks again, up to three more times, a poll interval
  (`CAPCOMD_GITHUB_POLL_MS`, 5 seconds by default) apart. If every try fails, the merge fails with
  `GitHub failed to merge PR #N (500, 4 tries)… merge again later` instead of `GitHub refused merge of PR #N (500)`.

# Spec

The built-in forge-github retries a merge call GitHub fails with a 5xx (§15.2; from the final live run, where a bare 500 on `PUT …/merge` failed a planner's merge and it had to merge again under a new key): `land` reads the pull request again after a poll interval (one found merged is the landing, `already: false`) and calls the merge again, up to three more times; four failures are `{status: "failed", retryable: false}` naming the status and the tries. No hook, seam, route or contract shape changes.
