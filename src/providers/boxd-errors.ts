// Typed sandbox errors. Callers branch on these instead of on SDK classes, so
// the orchestrator never depends on @boxd-sh/sdk directly.
export class SandboxError extends Error {
  readonly kind: string = "sandbox";
  constructor(message: string, readonly vmId?: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}
/** Org quota / rate limit (gRPC RESOURCE_EXHAUSTED). Retry later or free capacity. */
export class SandboxQuotaError extends SandboxError { override readonly kind = "quota"; }
/** A call or readiness wait ran out of time (gRPC DEADLINE_EXCEEDED, waitReady timeout). */
export class SandboxTimeoutError extends SandboxError { override readonly kind = "timeout"; }
/** The VM is hibernated/suspended and must be woken before use. */
export class SandboxHibernatedError extends SandboxError { override readonly kind = "hibernated"; }
/** The VM no longer exists (destroyed, expired via deleteAfter, or never created). */
export class SandboxNotFoundError extends SandboxError { override readonly kind = "not_found"; }
/** Configuration refused locally, e.g. an empty egress allowlist (which boxd treats as unrestricted). */
export class SandboxConfigError extends SandboxError { override readonly kind = "config"; }

const GRPC = { DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, RESOURCE_EXHAUSTED: 8 } as const;

/** Map an SDK error (matched by class name + gRPC code, so a mocked SDK works too). */
export function mapBoxdError(err: unknown, vmId?: string, what = "boxd call"): Error {
  if (err instanceof SandboxError) return err;
  const e = err as { name?: string; constructor?: { name?: string }; grpcCode?: number; message?: string };
  const cls = e?.constructor?.name ?? e?.name ?? "";
  const msg = `${what} failed${vmId ? ` (vm ${vmId})` : ""}: ${e?.message ?? String(err)}`;
  if (cls === "NotFoundError" || e?.grpcCode === GRPC.NOT_FOUND) return new SandboxNotFoundError(msg, vmId, err);
  if (cls === "RateLimitError" || e?.grpcCode === GRPC.RESOURCE_EXHAUSTED) return new SandboxQuotaError(msg, vmId, err);
  if (e?.grpcCode === GRPC.DEADLINE_EXCEEDED || /deadline|timed? ?out/i.test(e?.message ?? "")) return new SandboxTimeoutError(msg, vmId, err);
  if (/hibernat/i.test(e?.message ?? "")) return new SandboxHibernatedError(msg, vmId, err);
  return err instanceof Error ? err : new Error(msg);
}
