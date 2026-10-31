# PROGRAM: making the desktop window faster with perfloop

You are an agent improving the capcomd desktop window's performance. This file is your procedure. The bench
(`deskbench`, DESKBENCH.md) measures; `perfloop` (tools/perfloop, design/perf-loop/SPEC.md) decides and remembers. You
change the app's code, one idea at a time, and keep a change only when the loop says it won and nothing visible broke.
The owner checks what the bench can't: feel, taste and behaviour.

## Setup (once per machine)

```sh
cd tools/perfloop && swift build -c release && cd -        # the runner; alias perfloop=$PWD/tools/perfloop/.build/release/perfloop
export PERFLOOP_APP=capcomd-desktop                       # the store: ~/.perfloop/capcomd-desktop (never inside the repo)
cd apps/menubar/app
swift build -c release --product CapcomdDeskBench          # on a clean checkout of main
perfloop store add .build/release/CapcomdDeskBench
perfloop champion set <hash from store add> --merged --scenario step --fixture crew17   # the owner does this
```

`perfloop describe --bench .build/release/CapcomdDeskBench` shows what the bench offers: scenarios, which number each
climbs on (`objective`), the guards that gate acceptance, fixtures, knobs.

## The loop

Start each session with `perfloop session start` and `perfloop exp status`. Then repeat:

1. **Look.** `perfloop exp status` says what is open and what each experiment needs next. The newest
   `~/.perfloop/capcomd-desktop/exp/<id>/explain.txt` says where the candidate's time went (its worst stretch: our
   frames, framework frames and the app frame they ran `under`). For a whole-run picture, `deskbench diff A B` on two
   time profiles. Pick the largest subtree that is ours or attributable to one of our frames. When the stretch is
   bodies (`Column×34`), its `causes:` line says which model properties were set before them;
   `perfloop causes <result.json>` prints the whole table, per step.
2. **Say it in one sentence.** The hypothesis names the subtree and why your change removes it: "the representable
   answers sizeThatFits itself, so Auto Layout never sizes 16 hosting views". One idea per experiment.
3. **Change the code**, on a work branch, in the app's own sources (`Sources/CapcomdDesk`, `Sources/CapcomdUI`,
   `Sources/CapcomdStore` when the model is the cost). **Commit it**: promotion refuses a dirty build, and the build
   stamp reads the commit.
4. **Run it.** `perfloop exp new "<hypothesis>" --build-cmd "swift build -c release --product CapcomdDeskBench" --bench .build/release/CapcomdDeskBench`
   builds, stores the binary under its hash, records your patch against the champion's commit and screens it (3
   interleaved pairs, ~40 s). For a knob instead of code: `perfloop exp new "<hypothesis>" --knobs reel.slide=clip`.
5. **Read `exp/<id>/explain.txt`** (or `perfloop explain exp/<id>`). Its last line is the next command.
   - `rejected`: the idea didn't pay. Drop the commit (`git reset --hard HEAD~1` on the work branch), go to 1.
   - `promising`: `perfloop exp full <id>` (5 + 5 pairs, ~3 min; extends itself to 8 + 8, 10 + 10 while unsure).
   - `won`: `perfloop exp promote <id>`, then open a PR with explain.txt and the patch. The champion moves now; you may
     climb on it before the PR merges. After the merge, the owner runs `perfloop champion merged <sha>`.
   - `lost`, `needsReview`: drop it, or ask the owner (needsReview means no decision at 10 + 10, or a guard asked).
6. **Stop** when `exp status` prints a `stop:` line (SPEC §5.3): the scenario meets its budget, no attributable subtree
   ≥ 5 % remains, 5 non-promising candidates in a row, or the session's 2 h / 20 candidates are spent. Say what you
   tried and what's left, from `perfloop ledger`.

## What decides

| Scenario | Objective (lower is better) | Budget (design/desktop/SPEC.md §1) |
|---|---|---|
| `step`, `jump`, `fling` | `mainThreadCpuMsPerStep` (instructions per step when CPU is noisy) | no dropped frame at 120 Hz with 17 agents |
| `switch` | `latencyMs` | first frame ≤ 50 ms |
| `open` | `latencyMs` | first frame ≤ 100 ms |
| `follow` | `latencyMs` | moving within 50 ms of the ask |
| `burst`, `typing` | guards only | a thread item re-renders its own column; typing stays in the composer |

A screen is promising when the candidate wins every pair and the median gain is ≥ max(5 %, the noise band). A full wins
when Mann-Whitney gives p < 0.05, the effect is ≥ the band, and the frame guards (hitch time ratio, longest stretch)
are not worse beyond theirs. Correctness guards (`landed`, the scenario's checks) veto any win. A win must not be worse
on the second fixture (`swarm64`). Late-frame counts and frame p95 are information: when the frame rate changed
between builds, `explain` says so, and they mean nothing on their own (a 48 Hz build has twice the chances to be late).

## What you may not touch inside an experiment

- The bench: `Sources/CapcomdDeskBench` (scenarios, drivers, guards), `Sources/DeskBenchKit` (budgets, stats,
  fixtures), `tools/perfloop`, this file. Changes there are their own PR, reviewed by the owner (anti-Goodhart: the
  rules are read from the champion's manifest, so a candidate that changes them needs `--owner` anyway).
- No bench-only paths in the app: no `DESKBENCH_`/`PERFLOOP_` checks outside knobs, no fixture names, no "if
  measured" branches. A fast blank column is still a blank column.
- No knob that stays: a promoted knob is baked in as the default and deleted in a follow-up, this phase.
- Never `.relay/`, `.traces/`, `~/.capcomd`, `.trace` files or trace exports in a commit or patch (perfloop refuses
  such a patch; a trace holds the recorded process's environment).

## The machine

`exp screen`, `exp full` and `exp new` (which screens) open the bench window and take focus for minutes. Run them only
when the owner says the Mac is free; never send synthetic input to the system. `describe`, `store`, `explain`,
`status`, `ledger`, `diff` are headless and always fine.

## Ask the owner

- Anything that changes behaviour: declare it with `--behaviour-change`; promotion then needs the owner.
- Feel: a new animation curve, spring or gesture handling is judged on a real trackpad, not by the bench.
- Taste: anything that looks different (spacing, what a column shows while it builds).
- A `needsReview` verdict, a guard you think is wrong, a scenario or fixture you think is missing.
