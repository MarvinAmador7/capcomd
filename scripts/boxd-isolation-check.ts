#!/usr/bin/env bun
// Live check (needs BOXD_API_KEY): a process inside an agent VM, booted the way capcomd boots agents (isolated, from
// the env snapshot), can't mint boxd org credentials from the machine's metadata service. A machine that isn't
// isolated can (verified 2026-10-24), which is why agents only ever run isolated (BoxdProvider.ensure refuses
// anything else). Prints `ISOLATION OK` or `ISOLATION FAIL: <why>`; never prints a token.
import { BoxdProvider } from "../src/providers/boxd";
import { resolveEnvSnapshot } from "../src/env/resolve";

const PROBE = `
gw=$(awk 'NR>1 && $2=="00000000" {print $3; exit}' /proc/net/route)
[ -n "$gw" ] || { echo "no-route"; exit 0; }
ip=$(printf '%d.%d.%d.%d' 0x$(echo $gw | cut -c7-8) 0x$(echo $gw | cut -c5-6) 0x$(echo $gw | cut -c3-4) 0x$(echo $gw | cut -c1-2))
code=$(curl -s -m 5 -o /tmp/.probe -w '%{http_code}' "http://$ip:9002/v1/auth/token" || echo "unreachable")
if grep -q '"token"' /tmp/.probe 2>/dev/null; then token=1; else token=0; fi
echo "$code $token $(head -c 60 /tmp/.probe 2>/dev/null | tr -d '\\n' | grep -v token)"
rm -f /tmp/.probe
`;

const p = new BoxdProvider({ keepaliveMs: 0 });
const snap = resolveEnvSnapshot();
const { id } = await p.ensure({ idemKey: `capcomd-isolation-check-${Date.now()}`, isolated: true, ttlSeconds: 900, egressAllow: ["*"], labels: { purpose: "isolation-check" }, ...(snap ? { fromSnapshot: snap } : {}) });
let verdict = "";
try {
  await p.waitReady(id, 180_000);
  const out = (await p.exec(id, ["sh", "-c", PROBE], { timeoutMs: 60_000 })).stdout.trim();
  const [code, token, ...why] = out.split(" ");
  console.log(`agent-like VM ${id} (isolated, ${snap ?? "base image"}): metadata service answered ${code}${why.length ? ` (${why.join(" ")})` : ""}`);
  verdict = token !== "0" || code === "200" ? "ISOLATION FAIL: an agent VM got org credentials from its metadata service" : "ISOLATION OK";
} catch (e) {
  verdict = `ISOLATION FAIL: the check didn't run (${String((e as Error).message).slice(0, 200)})`;
} finally {
  await p.destroy(id).catch(() => {});
  await (p as any).close?.();
}
console.log(verdict);
process.exit(verdict === "ISOLATION OK" ? 0 : 1);
