// Serves site/dist locally, like a static host: index.html for "/", 404.html (status 404) for anything missing.
//   bun site/preview.ts            # http://127.0.0.1:4173
//   PORT=5000 bun site/preview.ts
import { join, normalize } from "node:path";

const dist = join(import.meta.dir, "dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4173),
  async fetch(req) {
    let path = normalize(decodeURIComponent(new URL(req.url).pathname));
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join(dist, path));
    if (!path.includes("..") && (await file.exists())) return new Response(file);
    return new Response(Bun.file(join(dist, "404.html")), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`capcomd site on http://${server.hostname}:${server.port}`);
