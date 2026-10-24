#!/usr/bin/env bun
// From a checkout: `bun run start [--run <runId> | --fixture NAME]` (CAPCOMD_BIN overrides the CLI it runs).
import { runTui } from "./run";

process.exit(await runTui(Bun.argv.slice(2)));
