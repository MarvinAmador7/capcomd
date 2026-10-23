# relay: current decisions (2026-10-17)
| # | Decision | Source |
|---|---|---|
| 1 | **TypeScript on Bun** | ADR-006 |
| 2 | **Rivet Actors from day one**, on the **LOCAL engine only** for now. Rivet Cloud is deferred for later evaluation (**ADR-009 status = Deferred**) | ADR-004, ADR-007, ADR-009 |
| 3 | **Lifecycle state in `c.db` transactions** (lifecycle row + event with UNIQUE idem_key + outbox, atomically); **XState v5 pure transitions** only (no interpreter/timers); `c.state` not used for durable data | ADR-008, rivet-sqlite.md |
| 4 | **boxd is the first sandbox backend**, behind the `SandboxProvider` interface (isolated VMs, an egress allowlist per profile (open by default since ADR-019 §7; never an accidental empty one), deleteAfter TTL, name = idempotency key) | ADR-005 amend. 2, boxd.md |
| 5 | **`bun build --compile` is broken with rivetkit's native module** (napi not embedded → WASM fallback → errors); run the actor host via `bun run` | rivet-sqlite.md, ADR-006 amend. |
| 6 | Supporting: hierarchical planners / isolated workers / judge / green branch; event log as source of truth; verification not self-report | ADR-001..003 |
| 7 | Durability: failure matrix, chaos suite (bun test + kill points), local backup plan | durability.md |
