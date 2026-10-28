import { survive } from "./survive";
const [kp, mode, port, n] = process.argv.slice(2);
// Always a private engine (survive refuses :6420 and the default data dir).
const opts = { port: Number(port ?? 7520), dataDir: `/tmp/chaos-measure-${port ?? 7520}`, repo: mode === "repo" };
const t = Date.now();
const r = await survive(kp!, Number(n ?? 1), mode !== "norequire", opts, process.env.QUIET !== "0");
console.log(JSON.stringify({ kp, mode, ok: r.ok, killed: r.killed, total: Date.now() - t, phases: r.phases, err: r.error?.slice(0, 1500) }));
process.exit(0);
