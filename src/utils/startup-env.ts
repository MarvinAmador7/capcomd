// The environment this process started with, before `src/cli/apply-config.ts` filled in the persisted settings (it
// imports this module first). `capcomd mcp` starts the server for another project from it, so that one applies its
// own project's settings rather than this directory's.
export const STARTUP_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });
