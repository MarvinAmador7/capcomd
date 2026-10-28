# Rivet's SQLite engine (per-actor `c.db`)
> Reconstruction: HIGH confidence (verbatim from transcript). Note: the box test directory /tmp/rsq was lost in the reset; results are as recorded at the time.

Researched 2026-10-17. **[Doc]** = Rivet docs/blog/crate docs (URL). **[Test]** = run on the box. **[Inference]** = ours.

## Sources
- S1 SQLite docs: https://rivet.dev/docs/actors/sqlite
- S2 State docs: https://rivet.dev/docs/actors/state
- S3 Launch changelog (2026-02-26): https://rivet.dev/changelog/2026-02-26-sqlite-for-rivet-actors/
- S4 Engine blog (2026-07-31): https://rivet.dev/blog/2026-07-31-how-we-built-the-first-zero-disk-s3-tiered-storage-engine-for-sqlite/
- S5 VFS crate: https://docs.rs/rivet-depot-client/latest/depot_client/ (vfs: https://docs.rs/rivet-depot-client/latest/depot_client/vfs/index.html)
- S6 Transaction coordinator: https://docs.rs/rivetkit-core/latest/src/rivetkit_core/actor/sqlite/tx.rs.html
- S7 npm `rivetkit` 2.3.27 (modified 2026-10-12)
- Not searched in depth: X posts by Nathan Flurry or Nicholas Kissel, and GitHub issues. Docs and the blog were sufficient.

## What it is
- **Name [Doc S4, S5]:** there's no product brand. The blog calls it "Rivet's SQLite storage engine". In code it's **depot**: the `depot` storage service plus `depot-client`, a "Custom SQLite VFS backed by KV operations over the KV channel" used by `rivetkit-napi`.
- **Design [Doc S4]:**
  - Stock SQLite runs on a custom **VFS** (not FUSE). Page `xRead`/`xWrite`/`xSync` calls go to a remote **hot tier**: "RocksDB, Postgres, or FoundationDB depending on the deployment".
  - Actor compute is **zero-disk**. Pages are fetched on demand, with caching and prefetching.
  - 4 KiB pages are grouped into 256 KiB chunks. Chunks untouched for 7 days (configurable) move to S3 and are rehydrated on read.
  - It offers optional point-in-time recovery, plus a single-writer guard against dual writes.
- **Large commits [Doc S5]:** these are staged in segments and then published "making every staged segment visible at once". The crate also lists `BATCH_ATOMIC` and journal behaviour as invariants.
- **API [Doc S1]:** `db: db({ onMigrate })` from `rivetkit/db`. It provides `c.db.execute(sql, ...args | {named})`, which returns rows, and `c.db.transaction(async tx => …, { name, timeout })`. Drizzle is first-class via `c.vars.drizzle`. Inspector endpoints expose the schema and rows and allow ad-hoc execution.

## Answers
| Question | Answer |
|---|---|
| Durability on return | [Doc S4] "commits go to the replicated hot tier and return in low milliseconds"; the design target is "at least triple redundancy"; "A commit that is durable on only one machine is not durable". [Inference] Rivet Cloud should therefore be durable once the commit returns. In self-hosted setups durability equals your hot-tier backend's replication. No fsync details are stated. |
| Transactions | [Doc S1] `db.transaction()` commits when the callback resolves and rolls back on throw. Other SQL queues FIFO. Default timeout 60 s. Inside the callback use `tx`; using `c.db` deadlocks until the timeout. Manual BEGIN/COMMIT is still supported but "cannot protect against interleaving callers" and logs a warning. [Test] A failing insert rolled back the earlier update in the same tx (see below). |
| Migrations | [Doc S1] `onMigrate` is wrapped in a savepoint and is atomic; if it throws, everything rolls back before the actor starts. Drizzle offers generated migrations [Doc S3]. |
| Size limits | [Doc S4] "Bottomless" with no hard ceiling (contrasted with Durable Objects' 10 GB). Not documented: per-commit or per-row caps; large commits are staged [S5]. The local engine metadata showed `max_response_payload_size: 20971520` (20 MiB) [Test log]. |
| Performance | [Doc S4] Only qualitative: "commits return in low milliseconds", "hot pages read at near-in-memory speed", instant start. No benchmarks published. |
| Local vs cloud | [Doc S4] The same VFS runs everywhere; the hot tier is pluggable. [Test] `registry.start()` under Bun launched the bundled engine (`@rivetkit/engine-cli`) automatically. [Inference] Locally it's likely RocksDB/filesystem with single-machine durability; the local backend is unverified. |
| `c.state` vs `c.db` | [Doc S2] `c.state` saves on a throttle (default 1 s) and isn't tied to action boundaries; `saveState({immediate:true})` forces a save. These are **separate stores**, and nothing documents an atomic commit across them. |
| Bun | [Test] Bun 1.4.2 with rivetkit 2.3.27 under `bun run`: transactions work. |
| `bun build --compile` | [Test] **Failed.** The native `@rivetkit/rivetkit-napi-linux-x64-gnu` module isn't embedded; it logged "native runtime failed to load; falling back to wasm" and the action call then errored. A fix (shipping or externalising the .node file, or the wasm path) needs work. |
| Maturity | Launched 2026-02-26 [S3]; the tiered engine shipped 2026-07-31 [S4]; rivetkit 2.3.x. It's young but in active use. |

## Box test (/tmp/rsq, now lost)
- One transaction updates `lc` (the lifecycle row) and inserts `ev(k PRIMARY KEY)`.
- The second call reuses the key, so the insert hits a UNIQUE violation and the tx throws.
- Result: `lc` still held `e1`, not `BAD`, so the update rolled back with the failed insert. This is exactly ADR-008's "state + event with idem_key UNIQUE".
- The client only saw "An internal error occurred". Error details are masked, so relay must map constraint errors inside the action.

## Impact on relay design
1. **ADR-008's open question is answered: yes.** Write the lifecycle row and the event row in one `c.db.transaction({name:"lifecycle-transition"})`. Duplicate events are rejected atomically by `idem_key UNIQUE`. Catch the error inside the tx wrapper and treat it as "already applied".
2. **Don't put lifecycle or event-log data in `c.state`.** It is throttled and separate from `c.db`. Keep `c.state` for caches only, or use none at all.
3. **Event log durability:** with Rivet Cloud or a replicated hot tier (FDB or Postgres HA), an acknowledged commit is replicated [Doc]. A single-host local engine is only as durable as that host's disk [Inference]. Local mode must back up the engine data dir (durability.md).
4. **Avoid long transactions.** They serialize all actor SQL (FIFO). Never await LLM or VM calls inside a tx: run them before or after it with their own idempotency key, or as a workflow step (ADR-022). There is no outbox (docs/durability.md).
5. **Compiled single binary:** blocked for now. Ship as `bun run` plus node_modules, or fix the napi embedding.
