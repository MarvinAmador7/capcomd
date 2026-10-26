// Validates every mock response against openapi/capcomd.json with ajv (dev check; not run by CI).
// Usage: AJV_DIR=/path/with/node_modules bun validate.ts   (needs ajv + ajv-formats)
// Starts server.ts on a temp socket, hits every route plus the SSE stream (run-demo conn #1 + resume, compacted cursor,
// daemon, run-silent), and checks bodies, envelopes, and each frame's `data` against the *Data / *Frame schema
// whose x-event-type matches the SSE `event:` name.
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const req = createRequire(join(resolve(process.env.AJV_DIR ?? import.meta.dir), "noop.js"));
const Ajv2020 = req("ajv/dist/2020").default, addFormats = req("ajv-formats").default;
const specPath = resolve(import.meta.dir, "../../../../openapi/capcomd.json");
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv); ajv.addSchema(spec, "spec");
const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const resSchema = (path: string, method: string, status: number | string, ct = "application/json") =>
  ajv.compile({ $ref: `spec#/paths/${ptr(path)}/${method}/responses/${status}/content/${ptr(ct)}/schema` });
const byType = new Map<string, any>();
for (const [name, s] of Object.entries<any>(spec.components.schemas))
  if (s["x-event-type"]) byType.set(s["x-event-type"], ajv.compile({ $ref: `spec#/components/schemas/${name}` }));
const envelope = ajv.compile({ $ref: `spec#/paths/${ptr("/v1/events")}/get/responses/200/content/application~1json/schema/items` });

let failures = 0, checks = 0;
const check = (label: string, v: any, body: unknown) => {
  checks++;
  if (!v(body)) { failures++; console.log(`FAIL ${label}\n  ${ajv.errorsText(v.errors, { separator: "\n  " })}`); }
};

const sock = `/tmp/capcomd-validate-${process.pid}.sock`, TOKEN = "test-token";
const srv = Bun.spawn([process.execPath, resolve(import.meta.dir, "server.ts"), sock], { env: { ...process.env, TOKEN, HEARTBEAT_MS: "50" }, stdout: "ignore", stderr: "inherit" });
for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(50);
const auth = { authorization: `Bearer ${TOKEN}` };
const call = (path: string, init: RequestInit = {}) => fetch(`http://localhost${path}`, { unix: sock, ...init } as any);
async function route(path: string, spPath: string, method: string, status: number, init: RequestInit = {}) {
  const r = await call(path, { method: method.toUpperCase(), ...init });
  if (r.status !== status) { failures++; console.log(`FAIL ${method} ${path}: status ${r.status}, want ${status}`); return; }
  check(`${method.toUpperCase()} ${path} ${status}`, resSchema(spPath, method, status), await r.json());
}

// SSE: parse frames, validate each against its schema.
async function stream(scope: string, opts: { lastId?: number; ms?: number } = {}) {
  const ac = new AbortController(); const frames: { id?: string; event: string; data: any }[] = [];
  const t = setTimeout(() => ac.abort(), opts.ms ?? 3000); // a dropped conn may never signal EOF
  try {
    const r = await call(`/v1/streams/${scope}/events`, { headers: { ...auth, ...(opts.lastId ? { "last-event-id": String(opts.lastId) } : {}) }, signal: ac.signal });
    if (r.headers.get("content-type") !== "text/event-stream") { failures++; console.log(`FAIL ${scope} content-type`); }
    const reader = r.body!.getReader(); let buf = "";
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += new TextDecoder().decode(value);
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const f: any = { event: "message", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const [k, ...v] = line.split(": "); if (k === "id") f.id = v.join(": "); else if (k === "event") f.event = v.join(": "); else if (k === "data") f.data += v.join(": ");
        }
        if (f.data) { f.data = JSON.parse(f.data); frames.push(f); }
      }
    }
  } catch (e: any) { if (e.name !== "AbortError" && !/abort|closed|reset|terminated|socket/i.test(String(e))) throw e; }
  clearTimeout(t);
  for (const f of frames) {
    const isFrame = f.event === "stream.reset" || f.event.startsWith("snapshot.");
    const label = `${scope} ${f.id ? `#${f.id} ` : ""}${f.event}`;
    if (!isFrame) {
      check(`${label} envelope`, envelope, f.data);
      if (f.data.type !== f.event) { failures++; console.log(`FAIL ${label}: envelope type ${f.data.type}`); }
      if (f.id !== String(f.data.seq)) { failures++; console.log(`FAIL ${label}: id != seq`); }
    }
    const v = byType.get(f.event);
    if (!v) { failures++; console.log(`FAIL ${label}: no schema with x-event-type ${f.event}`); continue; }
    check(`${label} data`, v, isFrame ? f.data : f.data.data);
  }
  return frames;
}

try {
  await route("/v1/health", "/v1/health", "get", 200);
  await route("/v1/runs", "/v1/runs", "get", 401);
  await route("/v1/runs", "/v1/runs", "get", 200, { headers: auth });
  await route("/v1/runs/run-demo", "/v1/runs/{runId}", "get", 200, { headers: auth });
  await route("/v1/runs/run-nope", "/v1/runs/{runId}", "get", 404, { headers: auth });
  await route("/v1/runs/run-demo/agents", "/v1/runs/{runId}/agents", "get", 200, { headers: auth });
  await route("/v1/events?scope=run-demo&after=0", "/v1/events", "get", 200, { headers: auth });
  const post = (key: string | null, body: any) => ({ method: "POST", headers: { ...auth, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
  const D = "/v1/approvals/{approvalId}/decision";
  await route("/v1/approvals/apr-6/decision", D, "post", 200, post("key-aaaaaaaa", { decision: "approve" }));
  await route("/v1/approvals/apr-6/decision", D, "post", 200, post("key-aaaaaaaa", { decision: "approve" }));
  await route("/v1/approvals/apr-6/decision", D, "post", 409, post("key-aaaaaaaa", { decision: "deny" }));
  await route("/v1/approvals/apr-6/decision", D, "post", 409, post("key-bbbbbbbb", { decision: "deny" }));
  await route("/v1/approvals/apr-6/decision", D, "post", 422, post("short", { decision: "approve" }));
  await route("/v1/approvals/apr-99/decision", D, "post", 404, post("key-cccccccc", { decision: "approve" }));

  const c1 = await stream("run-demo");
  const c2 = await stream("run-demo", { lastId: 22 });
  const seqs = [...c1, ...c2].filter(f => f.id).map(f => Number(f.id));
  console.log(`run-demo conn1 ${c1.length} frames, conn2 ${c2.length} frames, seqs ${seqs[0]}..${seqs.at(-1)} (${new Set(seqs).size} unique)`);
  const names = c1.slice(12, 19).map(f => f.event);
  console.log("reset block:", names.join(" "));
  await stream("run-demo", { lastId: 1 });
  const d = await stream("daemon", { ms: 300 });
  console.log(`daemon ${d.length} frames`);
  await stream("run-silent", { ms: 200 });
} finally { srv.kill(); }
console.log(`${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
