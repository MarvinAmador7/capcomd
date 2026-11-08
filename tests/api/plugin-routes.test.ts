// Plugin API routes (plugin API §4.7.3, capability plugins.routes): the gateway in src/api/server.ts serves what an active
// plugin registered with ctx.api.route at METHOD /v1/x/<name>/<path>, with the caller's token checked against the
// route's declared scope and the handler run as the caller; a thrown PluginError keeps its code where the spec maps one,
// anything else is 500 "plugin error" with the message only in the daemon log; never a stream. Its feature flags join
// GET /v1/health, and GET /v1/plugins/{name} lists its routes and flags. The fixture: tests/plugins/fixtures/api-routes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelHost } from "../../src/plugins/host";
import { addClient, loadClients, mintPluginClient } from "../../src/api/clients";
import { PluginDetail } from "../../src/api/contract";
import { harnessApp, routeParams } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import type { PluginHost } from "../../packages/plugin/src/host/host";

const FIXTURE = join(import.meta.dir, "..", "plugins", "fixtures", "api-routes");
const NAME = "api-routes";

let dir: string, host: PluginHost, app: ReturnType<typeof harnessApp>;
const tokens: Record<"reader" | "steerer" | "configurer", { token: string; id: string }> = {} as never;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capcomd-plugin-routes-"));
  const cpath = join(dir, "clients.json");
  for (const [k, scopes] of [["reader", ["read"]], ["steerer", ["steer"]], ["configurer", ["read", "steer", "configure"]]] as const) {
    const made = addClient(k, [...scopes], cpath);
    tokens[k] = { token: made.token, id: made.client.id };
  }
  host = kernelHost({ log: false });
  await host.start([{ source: "builtin", dir: FIXTURE }]);
  expect(host.get(NAME)?.state).toBe("active");
  app = harnessApp({ source: memorySource({}), clients: () => loadClients(cpath), state: harnessState(null), plugins: () => host.list(), pluginHost: host });
});
afterAll(async () => { await host.stop(); rmSync(dir, { recursive: true, force: true }); });

const call = (path: string, who: keyof typeof tokens | null, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...(who ? { authorization: `Bearer ${tokens[who].token}` } : {}), ...(init.headers as Record<string, string> ?? {}) } });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

describe("the gateway (§4.7.3)", () => {
  test("a read route answers a read token, as the caller (a read-only client is a viewer), with its params and query", async () => {
    const r = await call(`/v1/x/${NAME}/echo/run%2D1?limit=3`, "reader");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await json(r)).toEqual({ route: "echo", params: { id: "run-1" }, query: { limit: "3" }, body: null, principal: { kind: "viewer", clientId: tokens.reader.id } });
    // A literal segment wins over a parameter.
    expect(await json(await call(`/v1/x/${NAME}/echo/latest`, "reader"))).toEqual({ route: "latest", params: {} });
  });

  test("the route's declared scope, not the method's: a token without it is 403, no token 401", async () => {
    const r = await call(`/v1/x/${NAME}/echo/1`, "steerer");
    expect(r.status).toBe(403);
    expect(await json(r)).toEqual({ code: "forbidden", message: "token lacks the read scope" });
    expect((await call(`/v1/x/${NAME}/echo/1`, null)).status).toBe(401);
    // DELETE needs configure here: steering isn't enough, and a route that answers nothing is 204.
    expect((await call(`/v1/x/${NAME}/items/7`, "steerer", { method: "DELETE" })).status).toBe(403);
    const gone = await call(`/v1/x/${NAME}/items/7`, "configurer", { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe("");
  });

  test("JSON in, JSON out, the caller's principal; a body that isn't JSON is 422", async () => {
    const r = await call(`/v1/x/${NAME}/items`, "steerer", { method: "POST", body: JSON.stringify({ title: "a digest" }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ created: { title: "a digest" }, principal: { kind: "operator", clientId: tokens.steerer.id } });
    const bad = await call(`/v1/x/${NAME}/items`, "steerer", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(422);
    expect((await json(bad)).code).toBe("invalid");
    // A plugin's token calls as the plugin, with its scopes.
    const own = mintPluginClient("someone", ["read", "steer"]);
    try {
      const p = await app.request(`/v1/x/${NAME}/items`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${own.token}` } });
      expect((await json(p)).principal).toEqual({ kind: "plugin", name: "someone", scopes: ["read", "steer"] });
    } finally { own.revoke(); }
  });

  test("a thrown PluginError keeps its status where the spec maps one; any other code is 500 \"plugin error\"", async () => {
    const statuses: Record<string, number> = { forbidden: 403, not_found: 404, conflict: 409, invalid: 422, unavailable: 503, timeout: 500, disposed: 500, unsupported: 500, widening: 500 };
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      for (const [code, status] of Object.entries(statuses)) {
        const r = await call(`/v1/x/${NAME}/fail/${code}`, "steerer", { method: "POST" });
        expect([code, r.status]).toEqual([code, status]);
        expect(await json(r)).toEqual(status === 500 ? { code: "internal", message: "plugin error" } : { code, message: `refused with ${code}`, hint: "Ask the operator." });
      }
    } finally { console.log = log; }
    expect(lines.some((l) => l.includes("refused with timeout"))).toBe(true);
  });

  test("a generic throw is 500 \"plugin error\": its message goes to the daemon log, never to the caller", async () => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    let r: Response;
    try { r = await call(`/v1/x/${NAME}/boom`, "reader"); } finally { console.log = log; }
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ code: "internal", message: "plugin error" });
    expect(text).not.toContain("hunter2");
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ plugin: NAME, level: "error", message: "GET /v1/x/api-routes/boom: the database password is hunter2-and-more", fields: {} }]);
  });

  test("never a stream: a route that answers with one is 500 \"plugin error\"", async () => {
    const log = console.log;
    console.log = () => {};
    let r: Response;
    try { r = await call(`/v1/x/${NAME}/stream`, "reader", { headers: { accept: "text/event-stream" } }); } finally { console.log = log; }
    expect(r.status).toBe(500);
    expect(r.headers.get("content-type")).not.toContain("text/event-stream");
    expect(await json(r)).toEqual({ code: "internal", message: "plugin error" });
  });

  test("an answer JSON.stringify refuses without throwing (a symbol) is 500 \"plugin error\", not a 200 null", async () => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    let r: Response;
    try { r = await call(`/v1/x/${NAME}/symbol`, "reader"); } finally { console.log = log; }
    expect(r.status).toBe(500);
    expect(await json(r)).toEqual({ code: "internal", message: "plugin error" });
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(["GET /v1/x/api-routes/symbol: its answer isn't JSON: a symbol"]);
  });

  test("what no active plugin serves is 404: another path, another method, another plugin", async () => {
    for (const [path, method] of [[`/v1/x/${NAME}/nothing`, "GET"], [`/v1/x/${NAME}/items`, "GET"], [`/v1/x/${NAME}/echo/1/more`, "GET"], ["/v1/x/nobody/echo/1", "GET"], [`/v1/x/${NAME}`, "GET"]] as const) {
      const r = await call(path, "configurer", { method });
      expect([path, r.status]).toEqual([path, 404]);
      expect((await json(r)).code).toBe("not_found");
    }
  });
});

describe("listing (§4.7.3, §13.2)", () => {
  test("GET /v1/plugins/{name} lists its routes and flags; health names the flag", async () => {
    const r = await call(`/v1/plugins/${NAME}`, "reader");
    expect(r.status).toBe(200);
    const d = PluginDetail.parse(await r.json());
    expect(d.routes).toEqual([
      { method: "GET", path: `/v1/x/${NAME}/echo/{id}`, scope: "read" },
      { method: "GET", path: `/v1/x/${NAME}/echo/latest`, scope: "read" },
      { method: "POST", path: `/v1/x/${NAME}/items`, scope: "steer" },
      { method: "POST", path: `/v1/x/${NAME}/fail/{code}`, scope: "steer" },
      { method: "GET", path: `/v1/x/${NAME}/boom`, scope: "read" },
      { method: "GET", path: `/v1/x/${NAME}/stream`, scope: "read" },
      { method: "DELETE", path: `/v1/x/${NAME}/items/{id}`, scope: "configure" },
      { method: "GET", path: `/v1/x/${NAME}/symbol`, scope: "read" },
    ]);
    expect(d.capabilities).toEqual([{ name: `x.${NAME}.digest`, doc: "GET /v1/x/api-routes/echo/{id}: an echo of what it was given." }]);
    const health = await json(await app.request("/v1/health"));
    expect(health.capabilities).toEqual(expect.arrayContaining(["plugins.routes", `x.${NAME}.digest`]));
  });

  test("a disposed plugin's routes are 404 and its flag leaves health; the listing falls back to what its manifest declares", async () => {
    expect((await call(`/v1/x/${NAME}/echo/1`, "reader")).status).toBe(200);
    await host.disable(NAME);
    expect(host.get(NAME)?.state).not.toBe("active");
    const r = await call(`/v1/x/${NAME}/echo/1`, "reader");
    expect(r.status).toBe(404);
    expect((await json(r)).code).toBe("not_found");
    expect((await json(await app.request("/v1/health"))).capabilities).not.toContain(`x.${NAME}.digest`);
    const d = PluginDetail.parse(await (await call(`/v1/plugins/${NAME}`, "reader")).json());
    expect(d.routes?.length).toBe(8);
    expect(d.capabilities).toEqual([]);
    await host.enable(NAME);
    expect((await call(`/v1/x/${NAME}/echo/1`, "reader")).status).toBe(200);
  });
});

describe("routeParams", () => {
  test("a {name} segment takes one non-empty segment, decoded; literals match exactly", () => {
    expect(routeParams("/v1/x/p/a/{id}", "/v1/x/p/a/b%20c")).toEqual({ id: "b c" });
    expect(routeParams("/v1/x/p/a/{id}", "/v1/x/p/a/")).toBeNull();
    expect(routeParams("/v1/x/p/a/{id}", "/v1/x/p/a/b/c")).toBeNull();
    expect(routeParams("/v1/x/p/a", "/v1/x/p/b")).toBeNull();
    expect(routeParams("/v1/x/p/a/{id}", "/v1/x/p/a/%E0%A4%A")).toBeNull();
    expect(routeParams("/v1/x/p/{a}/{b}", "/v1/x/p/1/2")).toEqual({ a: "1", b: "2" });
  });
});
