# ADR-006: Runtime — Rust vs TypeScript on Bun
> Reconstruction: **LOW confidence.** Only a summary of this document survived in my context; original prose, tables, citations and details are lost. This file contains only content I can recall; it must be re-researched/re-written before relying on it. (Amendment is HIGH confidence, adjusted for the deferral of ADR-009.)

Status: Accepted.

## Decision (recalled)
**TypeScript on Bun** (Marvin's stack: Hono + oRPC, Rivet, S2, Upstash, turbopuffer). Rust was rejected for iteration speed and ecosystem fit; a single compiled binary via `bun build --compile` was a stated hope.

## Amendment (2026-10-17)
`bun build --compile` currently **fails** with rivetkit: its native module `@rivetkit/rivetkit-napi-linux-x64-gnu` is not embedded, it falls back to WASM, and actor calls error (rivet-sqlite.md). Ship the actor host as `bun run` + node_modules (or a container if Rivet Cloud is adopted later, ADR-009 Deferred). The `capcomd` CLI may still be a compiled thin client (rivetkit/client only; unverified). XState itself compiles fine (ADR-008).
