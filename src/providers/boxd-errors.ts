// Typed sandbox errors. Callers branch on these instead of on SDK classes, so
// the orchestrator never depends on @boxd-sh/sdk directly.
export class SandboxError extends Error {
  readonly kind: string = "sandbox";
  constructor(message: string, readonly vmId?: string, override readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}
/** Org quota / rate limit (gRPC RESOURCE_EXHAUSTED). Retry later or free capacity. */
export class SandboxQuotaError extends SandboxError { override readonly kind = "quota"; }
/** A call or readiness wait ran out of time (gRPC DEADLINE_EXCEEDED, waitReady timeout). */
export class SandboxTimeoutError extends SandboxError { override readonly kind: string = "timeout"; }
/** A VM didn't become ready in time: the provider answered, the machine didn't boot (not an outage). */
export class SandboxNotReadyError extends SandboxTimeoutError { override readonly kind = "not_ready"; }
/** A command ran past its own time limit while the provider kept answering: the command's doing, not an outage. */
export class SandboxExecTimeoutError extends SandboxError { override readonly kind = "exec_timeout"; }
/**
 * The provider didn't answer: a refused or reset connection, gRPC UNAVAILABLE/INTERNAL/ABORTED, a 5xx, Docker's daemon
 * not running. Transient: a call that is safe to repeat is tried again, and an agent waits for its machine.
 */
export class SandboxUnavailableError extends SandboxError { override readonly kind = "unavailable"; }
/**
 * The provider didn't answer for the whole outage window (CAPCOMD_SANDBOX_OUTAGE_MS, 10 minutes by default): an agent
 * fails with this after waiting for its machine that long. Retryable: nothing was wrong with the agent's work.
 */
export class SandboxUnreachableError extends SandboxError { override readonly kind = "sandbox_unreachable"; readonly retryable = true; }
/** The VM is hibernated/suspended and must be woken before use. */
export class SandboxHibernatedError extends SandboxError { override readonly kind = "hibernated"; }
/** The VM no longer exists (destroyed, expired via deleteAfter, or never created). */
export class SandboxNotFoundError extends SandboxError { override readonly kind = "not_found"; }
/** Configuration refused locally, e.g. an empty egress allowlist (which boxd treats as unrestricted). */
export class SandboxConfigError extends SandboxError { override readonly kind: string = "config"; }

/** boxd rejected the credential (invalid/expired BOXD_API_KEY, or no permission). Non-retryable config error. */
export class SandboxAuthError extends SandboxConfigError { override readonly kind: string = "auth"; readonly retryable = false; }

const GRPC = { DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8, ABORTED: 10, INTERNAL: 13, UNAVAILABLE: 14, UNAUTHENTICATED: 16 } as const;

/** Error text of a provider that didn't answer: a connection that failed, a gateway or server error, a stopped daemon. */
const UNANSWERED = /ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|connection (refused|reset|closed|lost)|network is unreachable|service unavailable|bad gateway|gateway time-?out|(HTTP|status) 50[234]\b|Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|deadline exceeded/i;
/** A rate limit (try again later), as opposed to a quota that only freeing capacity cures. */
const RATE_LIMITED = /rate.?limit|too many requests|slow down/i;
/** Kinds (an error's `kind`, or the `code` it carries across an actor boundary) of a provider that didn't answer. */
const TRANSIENT_KINDS = new Set(["timeout", "unavailable"]);

/**
 * Transient: the sandbox provider didn't answer (a deadline, a timeout, a refused or reset connection, a 5xx, a rate
 * limit), so the same call may well work in a moment. Permanent: not found, a rejected credential, a quota, a bad
 * request, a VM that didn't boot, a command that ran out of its own time, and the outage error itself
 * (SandboxUnreachableError: the waiting is over). Also works on an error that crossed an actor boundary as a UserError
 * (its `code` is the kind it had).
 */
export function isTransientSandboxError(err: unknown): boolean {
  if (!err || isBoxdAuthError(err)) return false;
  const e = err as { kind?: unknown; code?: unknown; message?: unknown };
  if (err instanceof SandboxQuotaError) return RATE_LIMITED.test(err.message);
  if (err instanceof SandboxUnavailableError) return true;
  if (err instanceof SandboxTimeoutError) return !(err instanceof SandboxNotReadyError);
  if (err instanceof SandboxError) return false;
  const kind = String(e.code ?? e.kind ?? "");
  if (TRANSIENT_KINDS.has(kind)) return true;
  if (kind === "quota") return RATE_LIMITED.test(String(e.message ?? ""));
  // Anything that says what it is (not_found, auth, config, limit, not_ready, exec_timeout, …) is settled; only an
  // error without a kind of its own is read by its text.
  if (kind && !["error", "Error", "push_failed", "internal_error", "BoxdError", "APIStatusError"].includes(kind)) return false;
  return UNANSWERED.test(String(e.message ?? ""));
}

/** The provider was down for longer than the outage window (also after the error crossed an actor boundary). */
export function isSandboxUnreachable(err: unknown): boolean {
  const e = err as { kind?: unknown; code?: unknown } | null;
  return err instanceof SandboxUnreachableError || e?.code === "sandbox_unreachable" || e?.kind === "sandbox_unreachable";
}

/** True for a boxd credential failure, also after it crossed an actor boundary as plain text. */
export function isBoxdAuthError(err: unknown): boolean {
  if (err instanceof SandboxAuthError) return true;
  const e = err as { name?: string; constructor?: { name?: string }; grpcCode?: number; message?: string };
  const cls = e?.constructor?.name ?? e?.name ?? "";
  return cls === "AuthenticationError" || cls === "PermissionDeniedError" || e?.grpcCode === GRPC.UNAUTHENTICATED ||
    e?.grpcCode === GRPC.PERMISSION_DENIED || /AuthenticationError|invalid or expired api key|SandboxAuthError|BOXD_API_KEY was rejected/i.test(e?.message ?? String(err));
}

export const BOXD_AUTH_HINT = "Check BOXD_API_KEY (no quotes or trailing whitespace; create a fresh key in the boxd dashboard) and retry.";

/** Map an SDK error (matched by class name + gRPC code, so a mocked SDK works too). */
export function mapBoxdError(err: unknown, vmId?: string, what = "boxd call"): Error {
  if (err instanceof SandboxError) return err;
  const e = err as { name?: string; constructor?: { name?: string }; grpcCode?: number; message?: string };
  const cls = e?.constructor?.name ?? e?.name ?? "";
  const msg = `${what} failed${vmId ? ` (vm ${vmId})` : ""}: ${e?.message ?? String(err)}`;
  if (isBoxdAuthError(err)) return new SandboxAuthError(`${what} failed: BOXD_API_KEY was rejected by boxd (${cls || "auth error"}: ${e?.message ?? ""}). ${BOXD_AUTH_HINT}`, vmId, err);
  if (cls === "NotFoundError" || e?.grpcCode === GRPC.NOT_FOUND) return new SandboxNotFoundError(msg, vmId, err);
  if (cls === "RateLimitError" || e?.grpcCode === GRPC.RESOURCE_EXHAUSTED) return new SandboxQuotaError(msg, vmId, err);
  if (e?.grpcCode === GRPC.DEADLINE_EXCEEDED || /deadline|timed? ?out/i.test(e?.message ?? "")) return new SandboxTimeoutError(msg, vmId, err);
  // The SDK's transport failure (it already retried those a few times), and the statuses of a server that is down.
  if (cls === "APIConnectionError" || e?.grpcCode === GRPC.UNAVAILABLE || e?.grpcCode === GRPC.INTERNAL || e?.grpcCode === GRPC.ABORTED ||
    UNANSWERED.test(e?.message ?? "")) return new SandboxUnavailableError(msg, vmId, err);
  if (/hibernat/i.test(e?.message ?? "")) return new SandboxHibernatedError(msg, vmId, err);
  return err instanceof Error ? err : new Error(msg);
}
