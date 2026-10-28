// Renders site/src/static/og.png (1200×630) and the PNG icons from the built site, in headless Chrome.
//   bun site/build.ts --tools && bun site/tools/render.ts
// Needs Google Chrome (or set CHROME). Opens no window; uses a throwaway profile and a private port.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const site = join(import.meta.dir, "..");
const dist = join(site, "dist"), staticDir = join(site, "src", "static");
cpSync(join(site, ".tools"), join(dist, "_tools"), { recursive: true });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { const f = Bun.file(join(dist, new URL(req.url).pathname)); return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 }); } });
const chromeBin = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(join(tmpdir(), "capcomd-render-"));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = Bun.spawn([chromeBin, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run", "--disable-gpu", "about:blank"], { stdout: "ignore", stderr: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  let ws = "";
  for (let i = 0; i < 60 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as { type: string; webSocketDebuggerUrl: string }[]; ws = l.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? ""; } catch {} if (!ws) await sleep(100); }
  const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener("open", r, { once: true }));
  let id = 0; const pending = new Map<number, (m: any) => void>();
  sock.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); });
  const send = (method: string, params = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  async function shot(path: string, w: number, h: number, file: string, transparent = false) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    if (transparent) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}${path}` });
    await sleep(1200);
    const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    writeFileSync(join(staticDir, file), Buffer.from(r.result.data, "base64"));
    console.log("wrote", join(staticDir, file));
  }
  await send("Page.enable");
  await shot("/_tools/og.html", 1200, 630, "og.png");
  await shot("/_tools/icon.html", 32, 32, "favicon-32.png", true);
  await shot("/_tools/icon.html?solid", 180, 180, "apple-touch-icon.png");
  sock.close();
} finally {
  chrome.kill(); server.stop(true); await sleep(300);
  rmSync(profile, { recursive: true, force: true }); rmSync(join(dist, "_tools"), { recursive: true, force: true });
}
