# ADR-009: Rivet Cloud for actors, local mode for dev/tests
> Reconstruction: HIGH confidence (verbatim from transcript). **Status changed to Deferred** per Marvin (2026-10-17): the LOCAL engine only for now; Rivet Cloud to be evaluated later via the spike below.

Status: **Deferred** (originally Proposed, pending the spike). Date: 2026-10-17.

## Context
Workers already run remotely on boxd (ADR-005 amendment 2). Marvin was leaning towards Rivet Cloud; the decision is now deferred. The engine facts come from rivet-sqlite.md.

## Verified facts [Doc]
| Topic | Claim | URL |
|---|---|---|
| Deploy model | Rivet Cloud runs the control plane and storage. Your backend can run on **Rivet Compute** (Rivet runs your container) or be brought from Vercel/Railway/Cloudflare/AWS/K8s. | https://rivet.dev/pricing |
| Rivet Compute | "You supply a container image; Rivet builds it, pushes it ... provisions a managed pool, and gives you a URL." Listens on `RIVET_PORT` (default 3000). Deploy with `npx @rivetkit/cli deploy --token cloud_api_…`. A GitHub Actions setup gives per-PR namespaces. | https://rivet.dev/docs/deploy/cloud/compute/ |
| Worker modes | Long-running (connects out) or serverless (the control plane calls `/api/rivet/start`). Rivet Cloud sets `RIVETKIT_RUNTIME_MODE=serverless` on deploy. Pools route actors to hardware or regions. | https://rivet.dev/docs/workers/ |
| Auth | One endpoint `https://<namespace>:<token>@api.rivet.dev`. Tokens: `sk_` (backend, full access), `pk_` (public), `ck_` (connect only). `rivet token create`. JWTs and ACL rules are available on top. | https://rivet.dev/docs/connect |
| Regions | An actor is created in the region nearest the client (Anycast) or with `createInRegion: "atl"`, and never migrates. **No region list was found.** | https://rivet.dev/docs/regions/ |
| Pricing | Free: 100k awake actor-hours, $5 compute, 1 vCPU, 5 GB, 5M writes (hard limits). Hobby $20/mo + usage. Team $200/mo + usage. Usage: $0.05/1k awake actor-hours, $0.40/GB-mo, $0.20/M reads, $1/M writes, $0.15/GB egress, compute $0.000033/vCPU-s + $0.0000029/GiB-s. Instances 0.08 to 8 vCPU, up to 4 GiB. | https://rivet.dev/pricing |
| Backup/PITR | The pricing page lists "SQLite backup", "SQLite PITR" and "Forking" under **Enterprise Edition (BYOC/self-host)**. The engine blog describes PITR as optional. Whether Cloud plans include it is **unclear**. | pricing; engine blog (rivet-sqlite.md S4) |
| Self-host | Apache 2.0; "single Rust binary or Docker image"; filesystem or Postgres storage; FoundationDB is Enterprise-only. | https://rivet.dev/pricing |
| Limits | Action timeout defaults to 60 s; transactions 60 s (rivet-sqlite.md). Engine metadata showed a 20 MiB max response payload [Test]. No limits page found. | — |
| Latency | Only qualitative: commits in "low milliseconds" [engine blog]. **No numbers.** | — |

## What it means for us [Inference]
- **Our code runs in a container we supply,** so Bun is fine (`FROM oven/bun`). There's no need for `bun build --compile`, which sidesteps the napi embedding failure (rivet-sqlite.md).
- **Calling boxd from actors:** this is outbound gRPC from Rivet Compute to `boxd.sh:9443`. Put `BOXD_API_KEY` in the deployment's env/secrets. Long boxd calls must not block actions beyond 60 s: use `waitUntil` or the outbox with schedule-based polling. Serverless mode may sleep instances, so all progress lives in `c.db` and alarms (already the design).
- **Region placement:** the CLI creates the RunActor, so it lands near Marvin in Costa Rica. boxd regions are undocumented, so actor ↔ VM latency is unknown until measured.
- **Cost per run (rough):** 6 actor kinds, a ~2 h run, ~30 awake actors → about 60 actor-hours ≈ $0.003, plus compute (mostly idle-awaiting) ~0.1 vCPU × 2 h × 30 ≈ $0.71, plus writes (~50k → $0.05). This is negligible next to boxd VMs (~€0.1/h each) and model tokens. **Verify in the spike.**
- **Lock-in is low-to-moderate:** the same rivetkit code runs locally, self-hosted or on Cloud. Only the endpoint changes.

## Decision
Originally proposed: **Rivet Cloud (Rivet Compute, Hobby tier) for actors in staging/production; local mode** for dev, CI and the chaos suite. **Current status: Deferred.** relay runs on the local Rivet engine only; this ADR is the evaluation plan for later. Workers stay on boxd.

## Lock-in mitigation
1. `relay export` / `relay import` (logical NDJSON per actor; durability.md) on a nightly schedule to our own S3/R2.
2. Keep the code to plain rivetkit APIs; no Cloud-only features in the core path.
3. Self-host fallback: the Rivet engine (single binary or Docker) with Postgres storage on one VM, rehearsed by importing an export.
4. Make the endpoint configuration only (`RIVET_ENDPOINT`).

## Pre-commit spike checklist (all must pass before un-deferring)
- [ ] Deploy RunActor + TaskBoardActor (Bun image) with `@rivetkit/cli deploy`; the CLI connects with an `sk_` token.
- [ ] Call boxd from an actor: create a VM, exec, destroy, and measure each step.
- [ ] Kill test: crash the runner mid-transaction and after commit; check `checkInvariants()` against the Cloud namespace. Redeploy mid-run (drain on version upgrade).
- [ ] Latency from Costa Rica: p50/p95 for an action round trip and for `c.db.transaction` commits; actor ↔ boxd exec RTT. Record which Rivet region was chosen.
- [ ] Cost: run a synthetic 20-task run; read Rivet usage and boxd metering (which lags ~25 min); extrapolate cost per run.
- [ ] Confirm with Rivet whether backup/PITR is available on Hobby/Team, the region list, limits, and data export tooling.
- [ ] Export → import into local mode → invariants pass.

## Consequences (if adopted later)
- "Single host" (ADR-004) would become "a single control plane": local for dev, Cloud for real runs.
- The ADR-006 single-binary goal would be relaxed: the CLI binary is just a thin client; actors ship as a container.
