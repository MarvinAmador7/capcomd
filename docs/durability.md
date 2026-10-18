# Durability: failure matrix, crash-test suite, local backup
> Reconstruction: HIGH confidence (verbatim from transcript), with one update: Rivet Cloud is deferred (ADR-009 = Deferred), so rows about Rivet Cloud describe the future option; current mode is the LOCAL engine.

2026-10-17. Builds on ADR-002 (event log), ADR-008 (lifecycles), rivet-sqlite.md, boxd.md, ADR-009. Claims about Rivet and boxd cite those docs; the expected behaviour below is **our design (inference)** and must be proven by the suite.

## Ground rules (design)
- Every state change = one `c.db.transaction` writing {lifecycle row, event row with UNIQUE idem_key, outbox rows}. Side effects only run from the outbox, after commit, and must be idempotent. [rivet-sqlite.md]
- External effects carry idempotency keys: VM name `relay-<run8>-<worker>-e<epoch>` (boxd), git push = `--force-with-lease` to a task branch, merge = compare-and-swap on the green-branch SHA, budget = `charge_id` UNIQUE.
- Leases carry an epoch; every worker result is guarded by `epochMatches`.
- Every VM has a boxd `deleteAfter` TTL [boxd.md].

## Failure matrix
| Failure | Expected behaviour | Recovery |
|---|---|---|
| Orchestrator process crash (local CLI/engine or runner) | Committed transactions survive; uncommitted ones are lost and their events never existed. Actors restart on the next request or alarm [Rivet docs]. | `onWake` re-dispatches undelivered outbox rows. In-flight model calls are lost and re-issued from the last committed state (cost: one duplicate model call). |
| Host reboot (local mode) | Same as a crash. The engine data dir survives on disk. | Restart `relay`; actors resume. Workers on boxd keep running until the lease expires. |
| Disk loss (local mode) | **Data loss back to the last backup.** | Restore the engine data dir from backup (below). Run the reconciler: list boxd VMs and remote task branches, mark unknown work `failed`, and reap the VMs. (On Rivet Cloud, if adopted later, storage is Rivet's replicated hot tier [rivet-sqlite.md].) |
| Worker VM death | The heartbeat stops, the lease expires, and the task returns to `pending` with epoch+1. Late results from the old epoch are rejected. | WorkerActor destroys or reaps the VM; a new VM is created under the new idem name. |
| boxd outage | VM create/exec fails; tasks stay leased until expiry, then go back to `pending`. Backoff is capped and the run goes to `degraded`. | Retry with backoff. Running VMs may survive; the reconciler adopts them by name if the epoch is still current. The bwrap local fallback is optional (ADR-005). |
| Rivet outage (Cloud, deferred) / local engine down | The CLI can't reach actors, but worker VMs keep running and pushing branches. No merges happen. | When Rivet is back, actors wake, process the queued heartbeats and results, and expire stale leases. |
| Network partition (orchestrator ↔ VM) | The worker can't report; the lease expires; a new epoch is assigned elsewhere. The old worker may still push. | Pushes go to `task/<id>/e<epoch>`; only the current epoch's branch is considered. The merge CAS prevents a stale merge. |
| Lease expiry | `LEASE_EXPIRED` → task back to `pending` (or `failed` once over the retry budget). Worker → draining → VM destroyed. | Automatic. |
| Duplicate delivery (action retry, client retry, outbox re-dispatch) | The UNIQUE idem_key insert fails and the transaction rolls back, so the call is treated as "already applied" and returns the stored result. | Automatic. |

## Crash-test suite
Run with `bun test tests/chaos/*.test.ts`. The harness is `tests/chaos/harness.ts`.
- **Mechanics:** Rivet local mode (`setupTest`/local engine) plus a `FakeSandboxProvider` and a fake model client. An env var `RELAY_KILLPOINT=<name>[:n]` makes `killpoint(name)` call `process.exit(137)` on its nth hit; the harness then restarts the process and lets the run finish. A real-boxd profile is nightly-only.
- **Kill points** (named calls in code):
  1. `tx.mid`: inside the lifecycle transaction, between the event insert and the lifecycle update. Expect: neither persisted.
  2. `model.after_return.before_commit`: expect the model call to repeat, with exactly one `task_handed_off` event.
  3. `merge.after_cas.before_event` and `merge.before_cas`: expect no double merge; the reconciler detects the green SHA already containing the task commit and records `merged` once.
  4. `push.mid` (the fake git remote drops the connection) and `push.after.before_event`: expect the push retried under the same branch and lease.
  5. `vm.create.after_request.before_record`: expect `ensure()` to find the VM by name, so exactly one VM exists.
  6. `lease.expire.mid`, `budget.charge.mid`, `outbox.dispatch.after_send.before_ack`.
- **Randomised mode:** 200 runs with a random kill point and random hit count, seeded and reproducible. Each failure prints its seed.
- **Invariants** (checked after every run by `checkInvariants()`):
  - *No double merge:* each task id appears at most once in `merged` events, and git history has one merge commit per task.
  - *No lost task:* every created task ends in a terminal state {merged, failed, cancelled} or is still live with a valid lease/pending state.
  - *No orphan VM beyond TTL:* the fake provider clock is advanced by TTL + reap interval, then `list("relay-")` must equal the VMs of live WorkerActors.
  - *Budget never double-charged:* the sum of `charges` equals the sum over distinct `charge_id`s and matches the model-call ledger.
  - *Event log gap-free:* `seq` is contiguous from 1 per RunActor, and every lifecycle row's `seq` equals its last event.
- **CI:** the deterministic kill points run on every PR; randomised runs are nightly.

## Local-mode backup plan (inference; the local engine's backend is unverified, assumed file-based RocksDB/fs)
1. Find the engine data dir (spike: inspect the `@rivetkit/engine-cli` config) and pin it with config, e.g. `~/.relay/engine`.
2. **Consistent snapshot:** stop relay (or run `relay pause`, which drains actors) → `tar --zstd` the dir → restart. Do this nightly and before upgrades. If the engine supports online checkpoints, switch to those.
3. **Logical export (backend-agnostic):** `relay export <runId>` calls a read-only action on each actor that dumps `lifecycle`, `lifecycle_events` and `outbox` as NDJSON. This is also the migration path to or from Rivet Cloud (ADR-009).
4. Ship backups off the host (e.g. S3/R2 with rclone); keep 7 daily + 4 weekly.
5. **Restore drill** (monthly, and in CI weekly on a sample): restore into a fresh dir, run the reconciler, then `checkInvariants()`.
