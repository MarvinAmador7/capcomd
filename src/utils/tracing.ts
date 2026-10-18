// Compatibility shim. The OTel SDK path did not work on Bun (see ADR-010);
// everything now goes through tracing-simple.
export * from "./tracing-simple";
export function initTracing(_opts: Record<string, unknown> = {}): void {}
export async function shutdownTracing(): Promise<void> {}
