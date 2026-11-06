// Spec §9.9: the out-of-process protocol is in the committed contract (openapi/capcomd.json, generated from
// src/api/contract.ts) under the capabilities plugins and plugins.protocol, and its wire shapes match the package's
// (packages/plugin/src/protocol.ts): the routes, the hooks stream's frames, the hook names.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_NAMES } from "../src/hooks";

const repo = join(import.meta.dir, "..", "..", "..");
const committed = JSON.parse(readFileSync(join(repo, "openapi", "capcomd.json"), "utf8"));
const ROUTES: Record<string, string[]> = {
  "/v1/plugins": ["get"], "/v1/plugins/{name}": ["get"], "/v1/plugins/{name}/enable": ["post"], "/v1/plugins/{name}/disable": ["post"],
  "/v1/plugins/{name}/sessions": ["post"], "/v1/plugins/{name}/hooks": ["get"], "/v1/plugins/{name}/hooks/{callId}": ["post"],
  "/v1/plugins/{name}/events": ["post"], "/v1/plugins/{name}/storage": ["get"], "/v1/plugins/{name}/storage/{key}": ["delete", "get", "put"],
};

describe("the plugin routes in openapi/capcomd.json", () => {
  test("every route of §9.9 is there, and the protocol's say whose token they take", () => {
    for (const [path, methods] of Object.entries(ROUTES)) {
      expect(Object.keys(committed.paths[path] ?? {}).sort()).toEqual(methods);
      for (const op of Object.values(committed.paths[path]) as Array<{ description: string; operationId: string; responses: Record<string, unknown> }>) {
        expect(op.description).toMatch(/^Capability plugins/);
        if (/^plugins\.(openSession|hooks|answer|emit|storage)/.test(op.operationId)) {
          expect(op.description).toMatch(/^Capability plugins\.protocol\. Only the token the daemon minted for this plugin's running process/);
          expect(op.responses).toHaveProperty("403");
        }
      }
    }
    expect(committed.paths["/v1/plugins/{name}/hooks/{callId}"].post.responses).toHaveProperty("204");
  });
  test("the hooks stream's frames and the hook names match the package", () => {
    const sse = committed.paths["/v1/plugins/{name}/hooks"].get.responses["200"].content["text/event-stream"].schema;
    const text = JSON.stringify(sse);
    for (const f of ["hook.call", "hook.dropped", "session.closing"]) expect(text).toContain(`"const":"${f}"`);
    const hookEnum = (JSON.stringify(committed.paths["/v1/plugins/{name}/sessions"].post.requestBody).match(/"enum":\[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => JSON.parse(s));
    expect(hookEnum.sort()).toEqual([...HOOK_NAMES].sort());
  });
  test("the protocol's events and capabilities are listed", () => {
    expect(committed.components.schemas).toHaveProperty("PluginProcessChangedData");
    for (const t of ["PluginLoadedData", "PluginFailedData", "PluginHookFailedData", "PluginSuspendedData", "PluginGateDeniedData", "PluginGateBypassedData"]) expect(committed.components.schemas).toHaveProperty(t);
    expect(JSON.stringify(committed)).toContain("`plugins.protocol`: The out-of-process plugin protocol, version 1");
  });
});
