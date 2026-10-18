# ADR-005: Sandbox and approval gates
> Reconstruction: **LOW confidence.** Only a summary of this document survived in my context; original prose, tables, citations and details are lost. This file contains only content I can recall; it must be re-researched/re-written before relying on it. (Amendment 2 text is HIGH confidence, verbatim.)

Status: Accepted (amended).

## Decision (recalled)
Workers run sandboxed; escalations (network, secrets, destructive actions) go through approval/policy gates. Original local sandbox: bwrap-style.

## Amendment 1 (recalled)
Sandboxing sits behind a `SandboxRunner` interface (later refined as `SandboxProvider` in boxd.md); Rivet agentOS is a candidate backend behind a spike (ADR-007).

## Amendment 2 (2026-10-16)
**boxd microVMs are the first `SandboxProvider` backend** (Marvin's choice; see boxd.md). Workers run in `isolated: true` boxd machines with an egress allowlist (non-empty; an empty list means unrestricted in boxd) and host-bound secrets. VMs are created from per-repo snapshots or forks. Approval gates are unchanged: escalation = changing the allowlist/secrets via the policy gate. The local bwrap backend stays as the offline/dev fallback, and agentOS remains spike-gated (ADR-007). The SandboxProvider interface is defined in boxd.md.
