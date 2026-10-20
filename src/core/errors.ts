export const SCHEMA = "relay.v1" as const;

export const EXIT = {
  ok: 0,
  run_failed: 1,
  usage: 2,
  not_found: 3,
  engine_unreachable: 4,
} as const;

export type ErrorCode = "run_failed" | "usage" | "not_found" | "engine_unreachable" | "conflict" | "config";

const EXIT_FOR: Record<ErrorCode, number> = {
  run_failed: EXIT.run_failed,
  usage: EXIT.usage,
  not_found: EXIT.not_found,
  engine_unreachable: EXIT.engine_unreachable,
  conflict: EXIT.run_failed,
  config: EXIT.usage,
};

/** An error with a stable code, an exit code and a next step for the caller. */
export class RelayError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  /** Additive detail (ADR-017): a finer reason (e.g. backpressure, deadlock, forbidden) and whether a retry may succeed. */
  readonly reason?: string;
  readonly retryable?: boolean;
  constructor(code: ErrorCode, message: string, hint: string, extra?: { code?: string; retryable?: boolean }) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.reason = extra?.code;
    this.retryable = extra?.retryable;
  }
  get exitCode(): number {
    return EXIT_FOR[this.code];
  }
  toJSON() {
    return { schema: SCHEMA, ok: false, error: { code: this.code, message: this.message, hint: this.hint, ...(this.reason ? { reason: this.reason } : {}), ...(this.retryable ? { retryable: true } : {}) } };
  }
}

export function toRelayError(error: unknown): RelayError {
  if (error instanceof RelayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|Unable to connect|fetch failed|ConnectionRefused|engine unreachable/i.test(message)) {
    return new RelayError("engine_unreachable", message, "Start the engine with `capcomd serve` and retry.");
  }
  if (/not.?found/i.test(message)) {
    return new RelayError("not_found", message, "Check the id with `capcomd status <runId>`.");
  }
  return new RelayError("run_failed", message, "Inspect `capcomd events <runId>` and `capcomd trace <runId>`.");
}
