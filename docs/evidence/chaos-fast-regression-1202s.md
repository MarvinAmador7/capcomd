# chaos:fast 525s → 1202s: root cause = host memory, not capcomd code

| | f758222 (525.0s) | bc45660 (1201.9s) |
|---|---|---|
| start line | workers=16 freeMB=6941 | workers=7 freeMB=2775 |
| serial-equivalent case time | 7973s | 8219s (+3%) |
| restart phase (killed cases) | 39.1–39.2s | 39.1–39.2s (same) |
| `engine-not-ready … cold restart` lines | 0 | 7 (earlier 16-worker runs: 1–10, e.g. chaos-fast-run-2.log has 10) |

- Wall time is roughly serial/N: 7973/16 ≈ 498s and 8219/7 ≈ 1174s, so the gap is entirely parallelism.
- N comes from `min(2×cores, (MemAvailable − 1GB)/250MB, 16)`. Bun's `os.freemem()` reports MemAvailable (checked: 2847MB vs /proc/meminfo 2915MB).
- The ~39s restart is the engine's 30s workflow-lease recovery plus boot. It was already there at f758222 (ADR-012 / db17bf2) and is not new. The `engine-not-ready` cold-restart retry is an existing harness path (tests/chaos/engine.ts:245) that showed up in earlier runs as well. These retries are at the start of a case and don't change case time (+3% total).
- Measured per-worker peak: 4 workers raised the cgroup's anon memory by 946MB, about 237MB each, so the 250MB estimate is right and raising N would risk OOM. See `chaos-fast-memory-measure-4w.log` (12/12 passed).
- Where the memory went: the box is shared. During the run, `free` showed 13.7GB used of 16GB, while this cgroup held only about 2.5GB anon + 1.7GB file. The rest is other sessions and processes on the box, e.g. sand-host at 1.2GB and a canvas vite dev server at 0.8GB, and a dev `capcomd serve :6420` that has been running since 20:07 (not started by the chaos harness). Not killed, because they aren't ours to kill.
- No new startup code path is involved: auth, profiles and the agents file aren't touched by the fake-agent chaos cases. Ports (7700+) and data dirs (/tmp/capcomd-chaos-fast/<slot>) are unchanged and per slot.
- Fix: none needed in capcomd. The harness now prints a `⚠ memory-limited` line with the reason. With ≥5.1GB available it runs 16 workers again (~9 min).
