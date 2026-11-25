# CHANGELOG

- A verification whose checks run past `CAPCOMD_CHECKS_TIMEOUT_MS` (20 minutes) on boxd now fails, with the check's
  output and a line saying it didn't finish in time. Before, it never ended: every poll started the checks again in a
  new VM. Name a check that ends on its own in the project's `run.checks` (for example `bun run test:fast`, not the
  whole `bun test`).
- An in-VM `capcomd verify` or `capcomd check` that waits through long checks no longer fails with "no answer from the
  orchestrator" or "HTTP request error … timed out" while the checks are still running: it keeps answering "running"
  until they finish.
