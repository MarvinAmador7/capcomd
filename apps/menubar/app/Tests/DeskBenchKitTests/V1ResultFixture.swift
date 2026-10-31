// A `deskbench.result/1` document as the bench wrote it on 2026-10-30, before the sampler (`step` on crew17, one rep,
// the performance session's `one-v1.json`), kept verbatim so later schema changes are checked against a real old result.
let v1StepResult = #"""
{
  "artifacts" : [

  ],
  "budget" : {
    "budget" : "Reel scroll: no dropped frames at 120 Hz with 17 agents",
    "pass" : false,
    "reasons" : [
      "late frames: median 6.0 per rep (max 6.0) at 24 Hz; frame p99 75.04 ms",
      "main-thread stretches over 16.7 ms: median 80.0 per rep (longest 216.87 ms)"
    ],
    "rule" : "no late frame while the reel moves; no stretch over 16.7 ms during a step"
  },
  "durationMs" : 10909,
  "exitCode" : 5,
  "fixture" : "crew17",
  "machine" : {
    "cores" : 8,
    "heavyProcesses" : [

    ],
    "loadAvg1" : 3.54,
    "loadPerCore" : 0.44,
    "lowPowerMode" : false,
    "memoryGB" : 16,
    "model" : "MacBookPro18,3",
    "os" : "Version 27.0.1 (Build 26A434)",
    "screenHz" : 120,
    "thermalState" : "nominal"
  },
  "noise" : {
    "idleLate" : 8,
    "idleLongestStretchMs" : 1070.24,
    "idleTicks" : 65,
    "quiet" : false,
    "reasons" : [
      "8 of 65 idle frames were late before the scenario started"
    ]
  },
  "params" : {
    "activate" : "true",
    "fixtureLoadMs" : "5.9",
    "host" : "scene",
    "steps" : "8",
    "window" : "1440x900"
  },
  "reps" : [
    {
      "bodies" : {
        "Column" : 32,
        "CrewTab" : 32,
        "OpenGroup" : 16,
        "Reel" : 16
      },
      "checks" : [
        {
          "detail" : "every step ended with the target column on screen",
          "name" : "landed",
          "pass" : true
        }
      ],
      "frames" : {
        "dropped" : 6,
        "late" : 6,
        "lateAtNominal" : 113,
        "lateRatio" : 0.0476,
        "maxMs" : 80.19,
        "measuredHz" : 24,
        "nominalHz" : 120,
        "p50Ms" : 41.66,
        "p95Ms" : 60.46,
        "p99Ms" : 75.04,
        "steadyHz" : 24,
        "ticks" : 126
      },
      "index" : 0,
      "mainThread" : {
        "busyMs" : 4949.4,
        "cpuMs" : 4884.2,
        "longestMs" : 216.87,
        "over100" : 8,
        "over16" : 80,
        "over250" : 0,
        "over33" : 75,
        "over8" : 89,
        "stretches" : 171
      },
      "steps" : [
        {
          "atMs" : 4801.7,
          "bodies" : {
            "Column" : 4,
            "CrewTab" : 4,
            "OpenGroup" : 2,
            "Reel" : 2
          },
          "durationMs" : 648.5,
          "frames" : {
            "dropped" : 2,
            "late" : 2,
            "lateAtNominal" : 13,
            "lateRatio" : 0.1333,
            "maxMs" : 75.04,
            "measuredHz" : 24,
            "nominalHz" : 120,
            "p50Ms" : 41.65,
            "p95Ms" : 75.04,
            "p99Ms" : 75.04,
            "steadyHz" : 24,
            "ticks" : 15
          },
          "mainThread" : {
            "busyMs" : 643.2,
            "cpuMs" : 634.3,
            "longestMs" : 192.36,
            "over100" : 1,
            "over16" : 8,
            "over250" : 0,
            "over33" : 7,
            "over8" : 9,
            "stretches" : 15
          },
          "name" : "step#0 0→3",
          "notes" : [

          ],
          "settleMs" : 643.6
        },
        {
          "atMs" : 5610.4,
          "bodies" : {
            "Column" : 4,
            "CrewTab" : 4,
            "OpenGroup" : 2,
            "Reel" : 2
          },
          "durationMs" : 657.2,
          "frames" : {
            "dropped" : 14,
            "late" : 11,
            "lateAtNominal" : 16,
            "lateRatio" : 0.6111,
            "maxMs" : 66.69,
            "measuredHz" : 25.9,
            "nominalHz" : 120,
            "p50Ms" : 38.55,
            "p95Ms" : 66.69,
            "p99Ms" : 66.69,
            "steadyHz" : 48,
            "ticks" : 18
          },
          "mainThread" : {
            "busyMs" : 634.2,
            "cpuMs" : 631.4,
            "longestMs" : 149.85,
            "over100" : 1,
            "over16" : 12,
            "over250" : 0,
            "over33" : 9,
            "over8" : 13,
            "stretches" : 25
          },
          "name" : "step#1 1→4",
          "notes" : [

          ],
          "settleMs" : 652.1
        },
        {
          "atMs" : 6427.8,
          "bodies" : {
            "Column" : 4,
            "CrewTab" : 4,
            "OpenGroup" : 2,
            "Reel" : 2
          },
          "durationMs" : 696.3,
          "frames" : {
            "dropped" : 1,
            "late" : 1,
            "lateAtNominal" : 14,
            "lateRatio" : 0.0714,
            "maxMs" : 80.19,
            "measuredHz" : 24,
            "nominalHz" : 120,
            "p50Ms" : 41.66,
            "p95Ms" : 80.19,
            "p99Ms" : 80.19,
            "steadyHz" : 24,
            "ticks" : 14
          },
          "mainThread" : {
            "busyMs" : 688.5,
            "cpuMs" : 685.6,
            "longestMs" : 216.87,
            "over100" : 1,
            "over16" : 11,
            "over250" : 0,
            "over33" : 11,
            "over8" : 12,
            "stretches" : 16
          },
          "name" : "step#2 2→5",
          "notes" : [

          ],
          "settleMs" : 681.9
        },
        {
          "atMs" : 7281.9,
          "bodies" : {
            "Column" : 4,
            "CrewTab" : 4,
            "OpenGroup" : 2,
            "Reel" : 2
          },
          "durationMs" : 701.7,
          "frames" : {
            "dropped" : 0,
            "late" : 0,
            "lateAtNominal" : 16,
            "lateRatio" : 0,
            "maxMs" : 50.02,
            "measuredHz" : 24,
            "nominalHz" : 120,
            "p50Ms" : 41.67,
            "p95Ms" : 50.02,
            "p99Ms" : 50.02,
            "steadyHz" : 24,
            "ticks" : 16
          },
          "mainThread" : {
            "busyMs" : 640.1,
            "cpuMs" : 636.3,
            "longestMs" : 85.43,
            "over100" : 0,
            "over16" : 14,
            "over250" : 0,
            "over33" : 13,
            "over8" : 14,
            "stretches" : 19
          },
          "name" : "step#3 3→6",
          "notes" : [

          ],
          "settleMs" : 657.3
        },
        {
          "atMs" : 8143.4,
          "bodies" : {
            "Column" : 4,
            "CrewTab" : 4,
            "OpenGroup" : 2,
            "Reel" : 2
          },
          "durationMs" : 654.9,
          "frames" : {
            "dropped" : 1,
            "late" : 1,
            "lateAtNominal" : 14,
            "lateRatio" : 0.0588,
            "maxMs" : 55.39,
            "measuredHz" : 23.6,
            "nominalHz" : 120,
            "p50Ms" : 42.3,
            "p95Ms" : 55.39,
            "p99Ms" : 55.39,
            "steadyHz" : 30,
            "ticks" : 17
          },
          "mainThread" : {
            "busyMs" : 650.5,
            "cpuMs" : 634.5,
            "longestMs" : 180.42,
            "over100" : 2,
            "over16" : 8,
            "over250" : 0,
            "over33" : 6,
            "over8" : 11,
            "stretches" : 19
          },
          "name" : "step#4 4→7",
          "notes" : [

          ],
          "settleMs" : 645.5
        },
        {
          "atMs" : 8955.6,
          "bodies" : {
            "Column" : 4,
            "CrewTab" : 4,
            "OpenGroup" : 2,
            "Reel" : 2
          },
          "durationMs" : 644.8,
          "frames" : {
            "dropped" : 41,
            "late" : 13,
            "lateAtNominal" : 13,
            "lateRatio" : 0.7222,
            "maxMs" : 72.27,
            "measuredHz" : 24.6,
            "nominalHz" : 120,
            "p50Ms" : 40.71,
            "p95Ms" : 72.27,
            "p99Ms" : 72.27,
            "steadyHz" : 90,
            "ticks" : 18
          },
          "mainThread" : {
            "busyMs" : 706.8,
            "cpuMs" : 703.8,
            "longestMs" : 112.13,
            "over100" : 2,
            "over16" : 13,
            "over250" : 0,
            "over33" : 13,
            "over8" : 14,
            "stretches" : 28
          },
          "name" : "step#5 5→8",
          "notes" : [

          ],
          "settleMs" : 639.9
        },
        {
          "atMs" : 9760.6,
          "bodies" : {
            "Column" : 4,
            "CrewTab" : 4,
            "OpenGroup" : 2,
            "Reel" : 2
          },
          "durationMs" : 648.7,
          "frames" : {
            "dropped" : 1,
            "late" : 1,
            "lateAtNominal" : 13,
            "lateRatio" : 0.0667,
            "maxMs" : 71.68,
            "measuredHz" : 24,
            "nominalHz" : 120,
            "p50Ms" : 41.66,
            "p95Ms" : 71.68,
            "p99Ms" : 71.68,
            "steadyHz" : 24,
            "ticks" : 15
          },
          "mainThread" : {
            "busyMs" : 635.1,
            "cpuMs" : 632.4,
            "longestMs" : 125.39,
            "over100" : 1,
            "over16" : 11,
            "over250" : 0,
            "over33" : 11,
            "over8" : 12,
            "stretches" : 27
          },
          "name" : "step#6 6→9",
          "notes" : [

          ],
          "settleMs" : 643.4
        },
        {
          "atMs" : 10569.4,
          "bodies" : {
            "Column" : 4,
            "CrewTab" : 4,
            "OpenGroup" : 2,
            "Reel" : 2
          },
          "durationMs" : 669.9,
          "frames" : {
            "dropped" : 0,
            "late" : 0,
            "lateAtNominal" : 13,
            "lateRatio" : 0,
            "maxMs" : 60.46,
            "measuredHz" : 21.4,
            "nominalHz" : 120,
            "p50Ms" : 46.8,
            "p95Ms" : 60.46,
            "p99Ms" : 60.46,
            "steadyHz" : 24,
            "ticks" : 13
          },
          "mainThread" : {
            "busyMs" : 663.1,
            "cpuMs" : 640.3,
            "longestMs" : 140.97,
            "over100" : 1,
            "over16" : 9,
            "over250" : 0,
            "over33" : 9,
            "over8" : 10,
            "stretches" : 21
          },
          "name" : "step#7 7→10",
          "notes" : [

          ],
          "settleMs" : 665
        }
      ],
      "window" : {
        "activityAsserted" : true,
        "appActive" : true,
        "backingScale" : 2,
        "frame" : [
          36,
          61,
          1440,
          888
        ],
        "keyWindow" : true,
        "occluded" : false,
        "visible" : true
      },
      "worstStretches" : [
        {
          "atMs" : 6907.2,
          "bodies" : {

          },
          "cpuMs" : 215.83,
          "durationMs" : 216.87,
          "step" : "step#2 2→5"
        },
        {
          "atMs" : 4831.4,
          "bodies" : {

          },
          "cpuMs" : 191.33,
          "durationMs" : 192.36,
          "step" : "step#0 0→3"
        },
        {
          "atMs" : 8226,
          "bodies" : {

          },
          "cpuMs" : 178.87,
          "durationMs" : 180.42,
          "step" : "step#4 4→7"
        },
        {
          "atMs" : 8535,
          "bodies" : {

          },
          "cpuMs" : 161.81,
          "durationMs" : 162.85,
          "step" : "step#4 4→7"
        },
        {
          "atMs" : 5832.1,
          "bodies" : {

          },
          "cpuMs" : 149.26,
          "durationMs" : 149.85,
          "step" : "step#1 1→4"
        },
        {
          "atMs" : 10740.5,
          "bodies" : {

          },
          "cpuMs" : 140.15,
          "durationMs" : 140.97,
          "step" : "step#7 7→10"
        },
        {
          "atMs" : 9973.8,
          "bodies" : {

          },
          "cpuMs" : 124.93,
          "durationMs" : 125.39,
          "step" : "step#6 6→9"
        },
        {
          "atMs" : 8982.1,
          "bodies" : {

          },
          "cpuMs" : 111.56,
          "durationMs" : 112.13,
          "step" : "step#5 5→8"
        }
      ]
    }
  ],
  "scenario" : "step",
  "schema" : "deskbench.result/1",
  "startedAt" : "2026-10-30T21:14:59Z",
  "summary" : {
    "bodies" : {
      "Column" : 32,
      "CrewTab" : 32,
      "OpenGroup" : 16,
      "Reel" : 16
    },
    "checksFailed" : [

    ],
    "droppedFrames" : {
      "mad" : 0,
      "max" : 6,
      "median" : 6,
      "min" : 6,
      "n" : 1,
      "p95" : 6
    },
    "frameP95Ms" : {
      "mad" : 0,
      "max" : 60.46,
      "median" : 60.46,
      "min" : 60.46,
      "n" : 1,
      "p95" : 60.46
    },
    "frameP99Ms" : {
      "mad" : 0,
      "max" : 75.04,
      "median" : 75.04,
      "min" : 75.04,
      "n" : 1,
      "p95" : 75.04
    },
    "hangsOver100" : {
      "mad" : 0,
      "max" : 8,
      "median" : 8,
      "min" : 8,
      "n" : 1,
      "p95" : 8
    },
    "lateFrames" : {
      "mad" : 0,
      "max" : 6,
      "median" : 6,
      "min" : 6,
      "n" : 1,
      "p95" : 6
    },
    "longestStretchMs" : {
      "mad" : 0,
      "max" : 216.87,
      "median" : 216.87,
      "min" : 216.87,
      "n" : 1,
      "p95" : 216.87
    },
    "mainThreadCpuShare" : 0.99,
    "reps" : 1,
    "settleMs" : {
      "mad" : 5.6,
      "max" : 681.9,
      "median" : 645.5,
      "min" : 639.9,
      "n" : 8,
      "p95" : 681.9
    },
    "steadyHz" : {
      "mad" : 0,
      "max" : 24,
      "median" : 24,
      "min" : 24,
      "n" : 1,
      "p95" : 24
    },
    "stretchesOver16" : {
      "mad" : 0,
      "max" : 80,
      "median" : 80,
      "min" : 80,
      "n" : 1,
      "p95" : 80
    }
  },
  "tool" : {
    "configuration" : "release",
    "name" : "CapcomdDeskBench",
    "version" : "1"
  },
  "verdict" : "untrusted",
  "window" : {
    "activityAsserted" : true,
    "appActive" : true,
    "backingScale" : 2,
    "frame" : [
      36,
      61,
      1440,
      888
    ],
    "keyWindow" : true,
    "occluded" : false,
    "visible" : true
  }
}
"""#
