// Usage: bun scripts/preflight.ts — validates BOXD_API_KEY (boxd machines.list) and, with
// CAPCOMD_AGENT=claude-code, ANTHROPIC_API_KEY (GET /v1/models). Never prints key material.
// Settings come as the CLI's do: the environment, then capcomd's config (the boxd key from the keychain).
import "../src/cli/apply-config";
import { runPreflight } from "../src/core/preflight";

const checks = await runPreflight({ ...process.env, CAPCOMD_SANDBOX: process.env.CAPCOMD_SANDBOX ?? "boxd" });
for (const c of checks) console.log(`   ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
