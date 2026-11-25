// `capcomd mcp` starts the engine when nothing answers (ADR-018 §2), and only on this machine. The start itself (a real
// `capcomd serve`) is in tests/scenarios/engine-live.test.ts.
import { afterAll, expect, test } from "bun:test";
import { testPort } from "../helpers/engine";
import { ensureEngine, localPort } from "../../src/core/engine-start";

const saved = { ...process.env };
afterAll(() => {
  for (const k of ["CAPCOMD_ENDPOINT", "CAPCOMD_NO_ENGINE_AUTOSTART"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

test("only a local endpoint is started", () => {
  expect(localPort("http://127.0.0.1:7123")).toBe(7123);
  expect(localPort("http://localhost")).toBe(6420);
  expect(localPort("https://engine.example.com:6420")).toBeNull();
});

test("no engine and autostart off: a typed error that says how to start one", async () => {
  process.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${await testPort()}`;
  process.env.CAPCOMD_NO_ENGINE_AUTOSTART = "1";
  const e: any = await ensureEngine({ timeoutMs: 2000 }).catch((x) => x);
  expect(e.code).toBe("engine_unreachable");
  expect(e.hint).toContain("capcomd serve");
});
