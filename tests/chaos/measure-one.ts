import { survive } from "./survive";
const [kp, mode, port] = process.argv.slice(2);
const opts = mode === "slow" ? {} : { port: Number(port ?? 7520), dataDir: `/tmp/chaos-measure-${port ?? 7520}` };
const t = Date.now();
const r = await survive(kp, 1, true, opts, true);
console.log(JSON.stringify({ kp, mode, ok: r.ok, killed: r.killed, total: Date.now() - t, phases: r.phases, err: r.error?.slice(0, 300) }));
process.exit(0);
