# ADR 010: Distributed Tracing (OTel conventions, tracing-simple runtime)

**Status:** Accepted, amended 2026-10-18 (see "Amendment: tracing-simple replaced the OTel SDK")  
**Date:** 2026-10-17  
**Authors:** Relay Team


## Amendment (2026-10-18): tracing-simple replaced the OTel SDK

**What changed.** Relay no longer uses the OpenTelemetry SDK at runtime. All spans go through
`src/utils/tracing-simple.ts`. `src/utils/tracing.ts` is now a re-export shim, and the
`@opentelemetry/*` packages are no longer imported anywhere.

**Why.**
- Under Bun, the SDK path didn't work. `BasicTracerProvider.addSpanProcessor` and the `Resource`
  exports the code relied on are not usable with the SDK 2.x API on Bun. The NDJSON exporter in the
  old `tracing.ts` was built but never registered, so no span ever reached disk. `initTracing` was
  never called from the CLI or the actors. In practice, tracing was off.
- Relay runs in two processes, the engine (actors) and the CLI. They need to write one trace per run
  without a collector. tracing-simple does that with almost no code:
  - `traceId = sha256("trace:" + runId)`, so every process agrees on the trace id without
    propagating context.
  - Actor spans with no in-process parent hang off a deterministic root span id
    (`sha256("root:" + runId)`). `relay trace` makes up that root when it isn't on disk.
  - Each span is appended to `.traces/<runId>.ndjson` (`appendFileSync`) the moment it ends, so a
    process killed at a killpoint keeps every span that finished before the kill. A
    `killpoint.<name>` marker span records where it died.
  - `AsyncLocalStorage` gives correct parent/child nesting inside a process.
- We keep the OTel *data model and semantic conventions* (`traceId`/`spanId`/`parentSpanId`,
  `status.code` 0/1/2, `gen_ai.*`, and our `relay.*`, `sandbox.*` and `git.*` attributes). Feeding these
  spans to a real OTLP exporter later is a mapping job, not a redesign.

**What is instrumented** (all automatic, no per-call code in the actors):
- `actor.<actor>.<action>`: every mutating actor action, via `traceActions()` (`get*` reads are skipped).
- `transition.<machine>`: every `transitionLifecycle`, with `relay.state_from`, `relay.state_to`,
  `relay.event_type` and `relay.machine_version`. The span ids are also written to
  `lifecycle_events.trace_id/span_id`.
- `model.generate`: `gen_ai.*` tokens and cost (a proxy over the model client).
- `sandbox.<op>`: every provider call (a proxy over the provider). `exec` of `git …` becomes `git.<subcommand>`.
- `git.merge_cas`: the verifier's compare-and-swap window, which brackets the two merge killpoints.
- `cli.run`: one per `relay run` invocation. A resumed run has several.

**OTLP status: not connected.** Nothing exports to an OTLP endpoint today, and
`OTEL_EXPORTER_OTLP_ENDPOINT` is ignored. The section above that describes OTLP is the intended
future design, not current behavior.

Set `RELAY_TRACE=off` to disable writing traces, and `RELAY_TRACE_DIR` to move them.

## Context

Relay orchestrates complex multi-actor workflows involving:
- Actor actions across 6 actor types (run, planner, taskBoard, worker, verifier, judge)
- State machine transitions with XState v5
- External calls (model APIs, sandbox providers, git operations)
- Asynchronous outbox-pattern message dispatch
- Chaos recovery scenarios requiring audit trails

Without instrumentation, debugging failures and understanding system behavior requires:
- Manual log correlation across actors
- No visibility into causal relationships between operations
- Difficulty measuring cost, latency, and failure modes
- No way to verify trace continuity after crash/restart

## Decision

We will use **OpenTelemetry** for distributed tracing with:

### 1. Instrumentation Points

**Actor Actions:**
- Every actor action creates a span: `actor.action_name`
- Attributes: `relay.run_id`, `relay.actor_key`, `relay.idempotency_key`

**State Transitions:**
- Machine transitions emit spans with events
- Attributes: `relay.state_from`, `relay.state_to`, `relay.event_type`, `relay.machine_version`

**External Calls:**
- Model calls follow `gen_ai.*` semantic conventions (model, tokens, cost)
- Sandbox ops: `sandbox.provider`, `sandbox.vm_id`, `sandbox.operation`
- Git ops: `git.operation`, `git.ref`, `git.sha`

**Lease Operations:**
- Grant, heartbeat, expiry all create spans
- Attributes: `relay.lease_epoch`, `relay.task_id`, `relay.worker_id`

### 2. Context Propagation

- Trace context (traceId, spanId) stored in `lifecycle_events` table
- Propagated across actor calls via attributes
- Outbox messages carry trace context for async dispatch
- After crash/restart, spans link to parent run trace

### 3. Exporters

**NDJSON File (default):**
- One file per run: `.traces/<runId>.ndjson`
- Line-delimited JSON spans
- No external dependencies
- Queryable with jq/grep

**OTLP (optional):**
- HTTP exporter to Jaeger, Langfuse, etc.
- Enabled via `OTEL_EXPORTER_OTLP_ENDPOINT` env var
- Batched span export for performance

### 4. Tools

**`relay trace <runId>`:**
- Reads NDJSON file
- Prints tree/waterfall view with durations
- Shows cost, failures, state transitions
- Falls back to lifecycle events if no trace file

**Canvas Integration:**
- Node click shows span waterfall
- Visual correlation with graph state

## Consequences

### Positive

- **Debuggability:** Full causal chain from run → plan → tasks → verify → merge
- **Observability:** Measure model costs, latency, sandbox time per task
- **Audit Trail:** Every event has trace context for compliance
- **Chaos Verification:** Spans prove trace continuity after restart
- **Standards-Based:** OpenTelemetry SDKs, semantic conventions

### Negative

- **Overhead:** Span creation adds ~50μs per operation (negligible vs I/O)
- **Storage:** NDJSON files grow with span count (~500 bytes/span)
- **Bun Compatibility:** OpenTelemetry SDK may have edge cases under Bun runtime

### Mitigations

- Use `BatchSpanProcessor` for OTLP to reduce overhead
- Implement sampling for high-volume runs (not needed for v0)
- Store traces only for completed runs, not in-progress (future)

## Alternatives Considered

### 1. Custom Logging

**Pros:** No dependencies, simple  
**Cons:** No standards, manual correlation, reinventing wheels

### 2. Datadog APM

**Pros:** Rich UI, auto-instrumentation  
**Cons:** Vendor lock-in, cost, requires agent

### 3. No Tracing

**Pros:** Simplest  
**Cons:** Unacceptable for production debugging

## Implementation

### Phase 1 (v0) ✓
- [x] Core tracing module (tracing-simple; the OTel SDK was dropped, see Amendment)
- [x] NDJSON exporter
- [x] `relay trace` command
- [x] Lifecycle table columns for trace_id/span_id
- [x] Basic tests (span creation, context serialization)

### Phase 2 (future)
- [x] Full actor action instrumentation (traceActions, 2026-10-18)
- [x] Automatic span creation via actor action wrapper
- [ ] Canvas waterfall UI
- [ ] Span-to-span linking after chaos restarts
- [ ] Sampling for high-throughput scenarios

## References

- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/otel/)
- [Semantic Conventions for GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)

## Verification

The following invariants must hold:

1. **Every event has a span:** `SELECT COUNT(*) FROM lifecycle_events WHERE trace_id IS NULL` = 0 (for traced runs)
2. **No orphan spans:** Every span except root has a valid parentSpanId
3. **Merged tasks have verify spans:** Every VERIFIED_AND_MERGED event has a corresponding verify span before it
4. **Chaos continuity:** After restart, new spans link to the run's original traceId
5. **Cost attribution:** Sum of `gen_ai.response.cost` across spans matches run budget

Tests enforce these invariants in `tests/tracing/invariants.test.ts`.
