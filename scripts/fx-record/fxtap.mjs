#!/usr/bin/env node
// Stands in for fx between the bridge and the real fx: runs /opt/fx/fx with the same arguments and records every ACP
// line each way to $FXTAP_OUT as {dir: "c2a"|"a2c", msg}, plus the arguments and the FX_* environment it ran with.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const out = process.env.FXTAP_OUT;
writeFileSync(out, JSON.stringify({ dir: "start", args: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FX_"))) }) + "\n");
const rec = (dir, line) => { let msg; try { msg = JSON.parse(line); } catch { return; } appendFileSync(out, JSON.stringify({ dir, msg }) + "\n"); };
const fx = spawn("/opt/fx/fx", process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
const lines = (stream, dir, sink) => { let b = ""; stream.on("data", (d) => { b += d; let n; while ((n = b.indexOf("\n")) >= 0) { const l = b.slice(0, n); b = b.slice(n + 1); rec(dir, l); sink(l + "\n"); } }); };
lines(process.stdin, "c2a", (l) => { try { fx.stdin.write(l); } catch {} });
process.stdin.on("end", () => fx.stdin.end());
lines(fx.stdout, "a2c", (l) => process.stdout.write(l));
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => fx.kill(s));
fx.on("exit", (code, signal) => { appendFileSync(out, JSON.stringify({ dir: "exit", code, signal }) + "\n"); process.exit(code ?? 128 + 15); });
