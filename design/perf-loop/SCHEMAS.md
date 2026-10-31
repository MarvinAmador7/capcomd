# Schemas

Every document `perfloop` or an adapter writes carries `"schema": "perfloop.<kind>/<n>"`. Rules, kept from
`deskbench.result/1`: within a version a field is never renamed or removed, only added; a reader of version n reads
n−1 (decoders for `deskbench.*/1` stay in `PerfLoopKit` and upgrade in memory); numbers are measured values rounded
as today (`Stats.round`), never interpolations; times are ms since the harness started unless named `*At` (ISO 8601).
JSON is pretty-printed with sorted keys (`JSONOut.encode`), so diffs of results are readable.

Exit codes stay: 0 pass · 1 usage · 2 harness error · 3 budget failed · 4 regression beyond noise · 5 untrusted.
Added: 6 refused (provenance: stale trace, unstamped binary, mixed runners) · 7 interrupted (the user touched the
machine; rerun).

## 1. Common objects

```jsonc
"build": {                       // perfloop.build/1, embedded wherever a binary is involved
  "hash": "sha256:…",            // of the executable file; the store's key
  "commit": "9bcd41a" | null,    // from the build stamp, not the cwd
  "dirty": false,                // uncommitted changes in tracked sources at build time
  "sourceHash": "sha256:…",      // tracked source paths' content hash: two clean builds of one commit agree
  "builtAt": "2026-10-30T15:31:02Z",
  "configuration": "release",
  "toolchain": "Xcode 27.1 (27A9275)",
  "stamp": true                  // false for binaries imported with `store import` (pre-stamp)
}
"machine": { …as today…, "runner": "local" | "ssh://mac-mini" | "vm:tart/…" }   // runner added
"tree": { "n": "symbol", "v": 123, "c": [ …tree… ] }     // folded call tree; v = samples (profile) or ms (diff)
```

## 2. `perfloop.manifest/1` (adapter `describe --json`)

```jsonc
{ "schema": "perfloop.manifest/1", "protocol": 1,
  "app": "capcomd-desktop", "adapter": "deskbench", "build": { …build… },
  "scenarios": [ {
      "name": "step", "summary": "…", "kind": "latency|smooth|isolation",
      "budget": "Reel scroll: no dropped frames at 120 Hz with 17 agents", "rule": "…", "latencyBudgetMs": null,
      "params": { "steps": "8" },
      "objective": "mainThreadCpuMsPerStep" | "instructionsPerStep" | "latencyMs",
      "guards": [ "landed", "built-within", "snapshot-diff" ],
      "guardParams": { "built-within.ms": 300, "snapshot-diff.tolerance": 0.005 },
      "frameGuards": [ "hitchTimeRatioMsPerS", "longestStretchMs" ],   // judged by their bands (Acceptance)
      "secondFixture": "swarm64"                 // promotion needs not-worse here
  } ],
  "isolationGuards": [ "burst", "typing" ],      // their checks run on every promotion, whatever the experiment climbs
  "fixtures": [ { …FixtureSpec as today…, "parametric": { "agents": [1, 64], "items": [50, 600] } } ],
  "knobs": [ { "name": "reel.slide", "type": "choice", "default": "ca", "choices": ["ca", "clip"], "since": "0.7" },
             { "name": "build.perFrame", "type": "int", "default": 2, "range": [1, 8] } ],
  "hosts": [ "scene", "window" ], "defaultHost": "scene",
  "probes": [ "Column", "ColumnHead", "ColumnThread", "EntryRow", "ColumnComposer", "CrewTab", "TitleBar", "OpenGroup", "Reel", "RootView", "DecisionBar", "FoldedDeck" ],
  "exitCodes": { "ok": 0, … } }
```

## 3. `perfloop.result/2` (from `deskbench.result/1`)

Everything in `deskbench.result/1` (`Results.swift`) stays with the same names and meaning. Added:

```jsonc
{ "schema": "perfloop.result/2",
  "tool": { …, "build": { …build… } },                 // ToolInfo.commit kept, now equal to build.commit
  "params": { …, "knobs": { "reel.slide": "ca", "build.perFrame": "2" } },   // the full knob vector, defaults included
  "profiled": false,                                   // true when a profiler was attached: never an objective input
  "runner": "local",
  "summary": {
    …as today…,
    "objective": { "name": "mainThreadCpuMsPerStep", "value": 41.2, "dist": { …Dist… } },
    "mainThreadCpuMsPerStep": { …Dist… },
    "instructionsPerStep": { …Dist… } | null,          // null where counters read zero (VM)
    "hitchTimeRatioMsPerS": { …Dist… },                // in-process: Σ max(0, interval − steadyFrame) / step seconds
    "guardsFailed": [ "built-within" ]
  },
  "reps": [ {
    …as today…,
    "sampler": { "hz": 1000, "samples": 2310, "overheadPct": 0.6, "gateMs": 4 },
    "steps": [ { …as today…, "cpuMs": 38.9, "instructions": 61200000, "hitchTimeRatioMsPerS": 0.0,
                 "causes": [ { "keyPath": "DeskModel.onScreen", "bodies": { "Column": 17, "CrewTab": 16 } } ],
                 "smoothness": { "positionErrorP95Pt": 0.8, "stalls": 0, "jerkP95": 1.9 } | null } ],
    "worstStretches": [ { …as today…,
                 "stacks": { …tree… } | null,          // folded, symbolised; null when the sampler was off
                 "samples": 231,
                 "topOurs": [ { "symbol": "ReelView.slide", "samples": 180 } ],
                 "topFramework": [ { "symbol": "LayoutEngineBox.sizeThatFits", "samples": 229, "under": "ReelRepresentable" } ],
                 "causes": [ … ] } ],
    "guards": [ { "name": "snapshot-diff", "pass": true, "detail": "0.1 % of pixels differ", "artifacts": ["…/step-rep0.png"],
                  "value": 0.001, "limit": 0.005, "review": null } ]   // review: true = over tolerance, the owner decides
  } ] }
```

`checks[]` is unchanged; `guards[]` is the subset that gates acceptance plus the new ones. `Budgets.evaluate` keeps
its rule text and adds nothing: the verdict words (`pass|fail|untrusted|regression`) are kept.

## 4. `perfloop.profile/2` (from `deskbench.profile/1`)

Kept: `template`, `trace`, `scenario`, `fixture`, `process`, `durationS`, `hitches`, `timeProfile`, `swiftUI`,
`signposts`, `inProcess`, `notes`. Added:

```jsonc
{ "schema": "perfloop.profile/2", "build": { …build… }, "machine": { … }, "runner": "local",
  "steps": [ { "name": "step#3 9→12", "startNs": …, "endNs": …, "source": "signpost|inProcess" } ],
  "tree": { …tree… },                    // main thread, whole recording, v = samples
  "treePerStep": [ { "step": "step#3 9→12", "tree": { …tree… } } ],
  "msPerStep": 312.4, "sampleIntervalMs": 1.0, "stepsCovered": 16, "stepsExpected": 16,
  "hitches": { …as today…, "timeRatioMsPerS": 60.4, "recordingS": 12.0 },
  "swiftUI": { "tables": [ …as today… ],
               "rootCauses": [ { "cause": "DeskModel.onScreen", "updates": 33, "views": { "Column": 17, "CrewTab": 16 } } ],
               "longUpdates": [ { "view": "Column", "ms": 23.1, "cause": "…", "severity": "…" } ] } }
```

## 5. `perfloop.diff/1`

```jsonc
{ "schema": "perfloop.diff/1", "scenario": "step", "normalisation": "msPerStep",
  "a": { "build": { … }, "profile": "…/base-step-time.json", "msPerStep": 630.5, "steps": 16 },
  "b": { "build": { … }, "profile": "…/v3-step-time.json",   "msPerStep": 590.7, "steps": 16 },
  "deltaMsPerStep": -39.8, "deltaPct": -6.3,
  "tree": { "n": "main thread", "a": 630.5, "b": 590.7, "d": -39.8, "c": [ … ] },
  "gains":  [ { "path": ["…", "NSScrollAnimationHelper"], "a": 153.2, "b": 0.0, "d": -153.2, "under": "HostingScrollView" } ],
  "losses": [ { "path": ["…", "LayoutEngineBox.sizeThatFits"], "a": 0.0, "b": 384.0, "d": 384.0, "under": "ReelRepresentable" } ],
  "moved":  [ { "symbol": "propagate_dirty", "fromUnder": "ScrollViewCommitMutation", "toUnder": "sizeThatFits" } ],
  "provenance": { "stale": false, "crossOS": false, "allowed": [] },
  "notes": [ "signposts missing in a: steps aligned on the in-process result" ] }
```

## 6. `perfloop.experiment/1` and the ledger

```jsonc
{ "schema": "perfloop.experiment/1", "id": "0007", "createdAt": "…", "state": "new|built|screened|promising|rejected|full|won|lost|needsReview|promoted|abandoned",
  "hypothesis": "sizeThatFits answers itself so Auto Layout never sizes 16 hosting views",
  "kind": "code" | "knob", "behaviourChange": false,
  "parent": { "experiment": "0005", "build": { …build… } },     // the champion at creation
  "patch": "exp/0007/patch.diff" | null, "knobs": { "reel.slide": "clip" } | null,
  "build": { …build… } | null,
  "scenario": "step", "fixture": "crew17", "secondFixture": "swarm64",
  "screen": { "pairs": 3, "results": [ "screen/a1.json", "screen/b1.json", … ], "objective": { "a": [..], "b": [..] },
              "wins": 3, "medianGainPct": 61.2, "band": 8.1, "guardsPassed": true, "guardReviews": null, "verdict": "promising" },   // needsReview: a guard asks the owner
  "full":   { "repsPerSide": 5, "extendedTo": 8, "mwuP": 0.004, "effectPct": 58.9, "band": 7.0,
              "frameGuards": { "hitchTimeRatioMsPerS": { "a": 41.0, "b": 2.1, "pass": true }, "longestStretchMs": { … } },
              "verdict": "won" },
  "isolation": [ { "scenario": "burst", "pair": { … }, "pass": true, "failures": [] } ],   // after a won full
  "guardRuns": [ { "at": "…", "pair": { … }, "isolation": [ … ], "params": { … }, "override": null, "failures": [], "reviews": [] } ],
  "guardParams": { "snapshot-diff.tolerance": 0.01 } | null,     // the owner's, from perfloop guards --guard-tolerance
  "confirmation": { "hitchesTrace": "/Users/…/.perfloop/capcomd-desktop/traces/0007-step-hitches.trace", "timeTrace": "…", "profile": "exp/0007/profile.json",
                    "compositorHitchTimeRatioMsPerS": 3.4 },
  "diff": "exp/0007/diff.json", "explain": "exp/0007/explain.txt",
  "promotedAt": "…" | null, "pr": "https://github.com/…/pull/48" | null,
  "notes": [ "ran on local, idle-gated; 1 rep interrupted and redone" ] }
```

`ledger.jsonl`: one line per state change, `{ "schema": "perfloop.ledger/1", "at": "…", "experiment": "0007",
"state": "promoted", "objective": { "before": 41.2, "after": 16.9 }, "build": "sha256:…", "by": "agent|owner" }`.
`champion.json`: `{ "schema": "perfloop.champion/1", "experiment": "0007", "build": { … }, "merged": false,
"parents": ["0005", "0002"], "mergedAncestor": "9bcd41a", "objectives": { "step": 16.9, "switch": 153.2 }, "since": "…" }`.
`parents` is the chain of earlier champions back to the newest merged one, and `mergedAncestor` is that merged commit,
so the loop can climb on unmerged champions (owner's decision, SPEC §7) and every champion still traces back to `main`.

## 7. `perfloop.sweep/1`

```jsonc
{ "schema": "perfloop.sweep/1", "scenario": "step", "build": { … }, "axis": [ { "name": "agents", "values": [4, 8, …, 64] } ],
  "points": [ { "agents": 4, "objective": 6.1, "dist": { … }, "hitchTimeRatioMsPerS": 0.0, "guardsPassed": true } ],
  "fit": { "model": "linear", "slope": 0.92, "intercept": 2.3, "r2": 0.98, "unit": "ms per step per agent" } }
```

## 8. `perfloop.gesture/1`

```jsonc
{ "schema": "perfloop.gesture/1", "name": "flick-left", "recordedAt": "…", "device": "trackpad", "hz": 120,
  "events": [ { "t": 0.0, "dx": -3.0, "dy": 0.0, "phase": "began", "momentum": "none", "precise": true }, … ] }
```

No text, no window contents, no identifiers: a gesture file is safe to commit.
