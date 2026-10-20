# DRAFT (not filed): engine restart on an existing data dir takes ~39s to serve actors; under host load actors stop during `waiting_for_response_start`

Status: draft for Marvin to review. Not filed upstream.
Target: rivet-dev/rivetkit issues.

## Environment
- rivetkit 2.3.27, bundled engine `@rivetkit/engine-cli-linux-x64-musl`
- Bun 1.4.2, Linux 6.12 (x86_64), 8 cores, 16 GB
- One engine plus runner per data dir (`rivetkit serve` equivalent), file-system data dir,
  14–16 isolated engines running at once on different ports (our chaos harness)

## What we see
1. **Slow cold restart (every time).** After SIGKILLing the runner and engine and starting
   them again on the same data dir, the first actor call returns after a median of
   **39.1s** (p50 39 155 ms, max 39 410 ms over 153 restarts on a quiet host). A fresh
   data dir is ready in about 1.8s. The steady ~39s looks like a fixed timeout (runner
   re-registration or lease expiry?) rather than work being done.
2. **Readiness errors under host load.** While the host is briefly overloaded (many
   engines restarting at once), calls fail with:
   - `_stopped_while_waiting: Actor <id> stopped during waiting_for_response_start`
   - `actor_ready_timeout` (45s+)
   - `http error response group=core code=internal_error "An internal error occurred"`

   In one 207-case run, all 20 slow cases fell inside a single ~240s window, with
   restarts up to 175s. Two of those cases failed with the errors above. The same code
   passed 207/207 on the next run.

## Reproduction (sketch)
1. `rivetkit serve` with a file data dir; call an action on any actor that uses `db()`.
2. SIGKILL the runner and the engine process group.
3. Start again on the same data dir; time the first `getOrCreate(...).action()`. It
   takes about 39s.
4. Do steps 1–3 for 14 engines at once to hit the readiness errors.

Evidence: `docs/evidence/chaos-fast-step2-run2-hoststall.log` (stall window, 2 errors)
and `docs/evidence/chaos-fast-step2-207of207.log` (per-phase timing).

## Questions for maintainers
- Is the ~39s wait on restart a known timeout (for example, the runner lease of the
  killed process expiring)? Can it be configured, or skipped when the previous runner
  is known to be dead?
- Is `stopped during waiting_for_response_start` safe to retry from the client
  (the action body never ran), or can the action have partly executed?
- Is there a readiness endpoint that is reliable after a restart? Today we probe
  with a real actor call.

## What we do meanwhile
We do not retry these errors in our chaos harness. Failures that carry these
signatures while at least 3 overlapping cases are also >3× the median phase time are
recorded as `host-stall` (see `tests/chaos/classify.ts`); everything else is a failure.
