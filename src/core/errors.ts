export const SCHEMA = "relay.v1" as const;

export const EXIT = {
  ok: 0,
  run_failed: 1,
  usage: 2,
  not_found: 3,
  engine_unreachable: 4,
} as const;

export type ErrorCode = "run_failed" | "usage" | "not_found" | "engine_unreachable" | "conflict";

const EXIT_FOR: Record<ErrorCode, number> = {
  run_failed: EXIT.run_failed,
  usage: EXIT.usage,
  not_found: EXIT.not_found,
  engine_unreachable: EXIT.engine_unreachable,
  conflict: EXIT.run_failed,
};

/** An error with a stable code, an exit code and a next step for the caller. */
export class RelayError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  constructor(code: ErrorCode, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
  get exitCode(): number {
    return EXIT_FOR[this.code];
  }
  toJSON() {
    return { schema: SCHEMA, ok: false, error: { code: this.code, message: this.message, hint: this.hint } };
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
