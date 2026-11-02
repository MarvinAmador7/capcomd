// Serves the static export (site/out) like a static host: "/" → index.html, "/x" → x.html, missing → 404.html;
// text is gzipped and hashed assets get a long cache, as a real host would do.
//   bun run build && bun run preview        # http://127.0.0.1:4173 (PORT=… to change)
import { join, normalize } from "node:path";

const out = join(import.meta.dir, "..", "out");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4173),
  async fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    if (path.includes("..")) return new Response("bad request", { status: 400 });
    const gz = (req.headers.get("accept-encoding") ?? "").includes("gzip");
    const send = async (file: ReturnType<typeof Bun.file>, status = 200) => {
      const headers: Record<string, string> = { "content-type": file.type };
      if (path.startsWith("/_next/static/")) headers["cache-control"] = "public, max-age=31536000, immutable";
      if (gz && /^(text\/|application\/(javascript|json|xml)|image\/svg)/.test(file.type)) {
        headers["content-encoding"] = "gzip";
        return new Response(Bun.gzipSync(new Uint8Array(await file.arrayBuffer())), { status, headers });
      }
      return new Response(file, { status, headers });
    };
    for (const candidate of [path, `${path}.html`, join(path, "index.html")]) {
      const file = Bun.file(join(out, candidate));
      if (candidate !== "/" && (await file.exists())) return send(file);
    }
    return send(Bun.file(join(out, "404.html")), 404);
  },
});
console.log(`capcomd site (static export) on http://${server.hostname}:${server.port}`);
