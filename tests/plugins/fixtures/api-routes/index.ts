// Test plugin (tests/api/plugin-routes.test.ts): routes under /v1/x/api-routes (plugin API §4.7.3). `GET /echo/{id}` and
// `POST /items` answer with what they were given and the caller's principal; `POST /fail/{code}` throws a PluginError of
// that code; `GET /boom` throws a plain Error whose message must stay in the daemon log; `GET /stream` answers with a
// stream, which the gateway refuses; `DELETE /items/{id}` answers with nothing; `GET /symbol` answers with a symbol, which
// isn't JSON. A feature flag, `x.api-routes.digest`.
import { definePlugin, PluginError } from "../../../../packages/plugin/src/index";
import type { PluginErrorCode } from "../../../../packages/plugin/src/errors";

export const plugin = definePlugin({
  activate(ctx) {
    ctx.api.route({ method: "GET", path: "/echo/{id}", scope: "read", async handler({ params, query, body, principal }) { return { route: "echo", params, query, body: body ?? null, principal }; } });
    ctx.api.route({ method: "GET", path: "/echo/latest", scope: "read", async handler({ params }) { return { route: "latest", params }; } });
    ctx.api.route({ method: "POST", path: "/items", scope: "steer", async handler({ body, principal }) { return { created: body, principal }; } });
    ctx.api.route({
      method: "POST", path: "/fail/{code}", scope: "steer",
      async handler({ params }) { throw new PluginError(params.code as PluginErrorCode, `refused with ${params.code}`, "Ask the operator."); },
    });
    ctx.api.route({ method: "GET", path: "/boom", scope: "read", async handler() { throw new Error("the database password is hunter2-and-more"); } });
    ctx.api.route({ method: "GET", path: "/stream", scope: "read", async handler() { return new ReadableStream({ start(k) { k.enqueue(new TextEncoder().encode("data: x\n\n")); k.close(); } }); } });
    ctx.api.route({ method: "DELETE", path: "/items/{id}", scope: "configure", async handler() { return undefined; } });
    ctx.api.route({ method: "GET", path: "/symbol", scope: "read", async handler() { return Symbol("not JSON"); } });
    ctx.api.capability("digest", "GET /v1/x/api-routes/echo/{id}: an echo of what it was given.");
  },
});
