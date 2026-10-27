// ADR-021 §2: Docker has no platform delete-after, so capcomd's sweep enforces the idle machine lifetime from its own
// ledger. Each container keeps the lifetime it was made with (a run's own, recorded at `run new`), and a renewal moves
// it by the lifetime it names. Docker is a stub CLI here: nothing talks to a real Docker.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerProvider } from "../../src/providers/docker";
import { MACHINE_PREFIX } from "../../src/providers/sandbox";

function stubDocker() {
	const dir = mkdtempSync(join(tmpdir(), "capcomd-dockerlife-"));
	const state = join(dir, "containers");
	mkdirSync(state);
	const bin = join(dir, "docker");
	writeFileSync(bin, `#!/bin/sh
S=${JSON.stringify(state)}
case "$1" in
  inspect) [ -f "$S/$4" ] && { echo running; exit 0; }; echo "Error: No such object: $4" >&2; exit 1;;
  run) n=; while [ $# -gt 0 ]; do [ "$1" = --name ] && n="$2"; shift; done; touch "$S/$n"; echo "id-$n"; exit 0;;
  ps) for f in "$S"/*; do [ -f "$f" ] && printf '%s\\trunning\\t2026-10-27 09:12:03 +0000 UTC\\n' "$(basename "$f")"; done; exit 0;;
  rm) rm -f "$S/$3"; exit 0;;
esac
echo "stub docker: unexpected $*" >&2; exit 1
`);
	chmodSync(bin, 0o755);
	return { bin, ledger: join(dir, "docker-ttl.json") };
}

test("each container keeps its own idle lifetime: the sweep deletes the 15-minute one and keeps the 4-hour one", async () => {
	const s = stubDocker();
	const p = new DockerProvider({ bin: s.bin, ledgerPath: s.ledger });
	const spec = (idemKey: string, ttlSeconds: number) => ({ idemKey, ttlSeconds, egressAllow: ["*"], isolated: true as const, labels: {} });
	const t0 = Date.now();
	const short = (await p.ensure(spec("run-a-agt-1-e1", 900))).id;
	const long = (await p.ensure(spec("run-b-agt-2-e1", 14_400))).id;
	const l = JSON.parse(readFileSync(s.ledger, "utf8"));
	expect(l[short]).toBeGreaterThanOrEqual(t0 + 900_000);
	expect(l[short]).toBeLessThan(t0 + 960_000);
	expect(l[long]).toBeGreaterThanOrEqual(t0 + 14_400_000);
	expect((await p.list(MACHINE_PREFIX)).map((v) => [v.name, v.deleteAt])).toEqual([[short, l[short]], [long, l[long]]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

	// 16 minutes on: only the 15-minute one is past its lifetime.
	expect(await p.sweep(t0 + 16 * 60_000)).toEqual([short]);
	expect((await p.list(MACHINE_PREFIX)).map((v) => v.name)).toEqual([long]);
	// A renewal (the running agent's lease) moves it by the lifetime it names, from now.
	await p.extendTtl(long, 900);
	const renewed = JSON.parse(readFileSync(s.ledger, "utf8"))[long];
	expect(renewed).toBeLessThan(t0 + 14_400_000);
	expect(await p.sweep(renewed - 1)).toEqual([]);
	expect(await p.sweep(renewed + 1)).toEqual([long]);
	expect(JSON.parse(readFileSync(s.ledger, "utf8"))).toEqual({});
});
