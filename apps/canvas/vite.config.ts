import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { env } from "../../src/utils/env";

/** Serves relay's `.traces/<runId>.ndjson` at `/api/trace/<runId>` in dev. */
function relayTraces(): Plugin {
  const dir = env("TRACE_DIR") ?? resolve(import.meta.dirname, "../../.traces");
  return {
    name: "relay-traces",
    configureServer(server) {
      server.middlewares.use("/api/trace/", async (req, res) => {
        const id = decodeURIComponent((req.url ?? "").replace(/^\//, "")).replace(/[^a-zA-Z0-9._-]/g, "_");
        try {
          res.setHeader("content-type", "application/x-ndjson");
          res.end(await readFile(resolve(dir, `${id}.ndjson`), "utf8"));
        } catch {
          res.statusCode = 404;
          res.end("");
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), relayTraces()],
  server: {
    port: 3000,
    host: true,
  },
});
