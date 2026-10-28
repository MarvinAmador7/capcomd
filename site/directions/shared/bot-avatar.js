// packages/bot-avatar/src/types.ts
var ROLES = ["planner", "lead", "worker", "critic", "other"];
var SIZES = ["xs", "small", "full"];
var SLOTS = ["palette", "antenna", "accessory", "head", "ears", "screen", "eyes", "mouth", "blush", "torso", "plate", "pose", "legs", "dither", "name"];
// packages/bot-avatar/src/catalog.ts
function sym(half) {
  return half.map((r) => r + [...r].reverse().join(""));
}
function art(rows, anchor, anchors) {
  return { rows, ...anchor ? { anchor } : {}, ...anchors ? { anchors } : {} };
}
var blank = (w) => ".".repeat(w);
function face(rows, h = 7, w = 12) {
  return art(Array.from({ length: h }, (_, i) => rows[i] ?? blank(w)), [0, 0]);
}
var xsFace = (rows) => face(rows, 5, 8);
var HEAD_STD = (topY, ear, extra = {}) => ({
  top: [9, topY],
  side: [14, topY + 1],
  earL: [ear, 8],
  earR: [18 - ear, 8],
  neck: [9, 15],
  visor: [3, 5],
  ...extra
});
var HEAD_XS = (topY, ear) => ({
  top: [6, topY],
  side: [9, topY + 1],
  earL: [ear, 5],
  earR: [12 - ear, 5],
  visor: [2, 3]
});
var heads = [
  {
    id: "dome",
    label: "Dome",
    weight: 6,
    roles: { planner: 8, lead: 6 },
    art: {
      std: art(sym([
        ".......BB",
        ".....BBBB",
        "...BBBBBB",
        "..BBBBBBB",
        ".BBBBBBBB",
        ".BBBVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        ".BBBVVVVV",
        "BBBBBBBBB",
        ".BBBBBBBB",
        "..BBBBBBB"
      ]), undefined, HEAD_STD(0, 0)),
      xs: art(sym(["....BB", "..BBBB", ".BBBBB", ".BBVVV", "BBVVVV", "BBVVVV", "BBVVVV", ".BBVVV", "BBBBBB", ".BBBBB"]), undefined, HEAD_XS(0, 0))
    }
  },
  {
    id: "round",
    label: "Round",
    weight: 5,
    art: {
      std: art(sym([
        "......BBB",
        "....BBBBB",
        "..BBBBBBB",
        ".BBBBBBBB",
        ".BBBBBBBB",
        "BBBBVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBBVVVVV",
        ".BBBBBBBB",
        "..BBBBBBB",
        "....BBBBB"
      ]), undefined, HEAD_STD(0, 0, { side: [13, 1] })),
      xs: art(sym(["...BBB", ".BBBBB", "BBBBBB", "BBBVVV", "BBVVVV", "BBVVVV", "BBVVVV", "BBBVVV", ".BBBBB", "...BBB"]), undefined, HEAD_XS(0, 0))
    }
  },
  {
    id: "square",
    label: "Square",
    weight: 4,
    roles: { critic: 6 },
    art: {
      std: art(sym([
        ".........",
        ".BBBBBBBB",
        "BGBBBBBBB",
        "BBBBBBBBB",
        "BBBBBBBBB",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBBBBBBB",
        "BBBBBBBBB",
        ".BBBBBBBB"
      ]), undefined, HEAD_STD(1, 0, { side: [15, 1] })),
      xs: art(sym([".BBBBB", "BGBBBB", "BBBBBB", "BBVVVV", "BBVVVV", "BBVVVV", "BBVVVV", "BBVVVV", "BBBBBB", ".BBBBB"]), undefined, HEAD_XS(0, 0))
    }
  },
  {
    id: "octagon",
    label: "Octagon",
    weight: 4,
    art: {
      std: art(sym([
        "....BBBBB",
        "...BBBBBB",
        "..BBBBBBT",
        ".BBBBBBBB",
        "BBBBBBBBB",
        "BBBBVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBBVVVVV",
        ".BBBBBBBB",
        "..BBBBBBB",
        "...BBBBBB"
      ]), undefined, HEAD_STD(0, 0, { side: [14, 1] })),
      xs: art(sym(["..BBBB", ".BBBBB", "BBBBBT", "BBBVVV", "BBVVVV", "BBVVVV", "BBVVVV", "BBBVVV", ".BBBBB", "..BBBB"]), undefined, HEAD_XS(0, 0))
    }
  },
  {
    id: "capsule",
    label: "Capsule",
    weight: 4,
    art: {
      std: art(sym([
        "......BBB",
        "....BBBBB",
        "...BBBBBB",
        "..BBBBBBB",
        ".BBBBBBBB",
        ".BBBVVVVV",
        ".BBVVVVVV",
        ".BBVVVVVV",
        ".BBVVVVVV",
        ".BBVVVVVV",
        ".BBVVVVVV",
        ".BBBVVVVV",
        ".BBBBBBBB",
        "..BBBBBBB",
        "....BBBBB"
      ]), undefined, HEAD_STD(0, 1, { side: [13, 1] })),
      xs: art(sym(["...BBB", "..BBBB", ".BBBBB", ".BBVVV", ".BVVVV", ".BVVVV", ".BVVVV", ".BBVVV", ".BBBBB", "..BBBB"]), undefined, HEAD_XS(0, 1))
    }
  },
  {
    id: "helm",
    label: "Helm (crest)",
    weight: 3,
    excludes: { antenna: ["ball", "bolt", "dish"] },
    art: {
      std: art(sym([
        "......TTT",
        ".....BTTT",
        "...BBBBBB",
        "..BBBBBBB",
        ".BBBBBBBB",
        ".BBBVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        "BBBVVVVVV",
        ".BBBVVVVV",
        "BBBBBBBBB",
        ".BBBBBBBB",
        "..BBBBBBB"
      ]), undefined, HEAD_STD(0, 0)),
      xs: art(sym(["....TT", "..BBTT", ".BBBBB", ".BBVVV", "BBVVVV", "BBVVVV", "BBVVVV", ".BBVVV", "BBBBBB", ".BBBBB"]), undefined, HEAD_XS(0, 0))
    }
  }
];
var screens = [
  { id: "night", label: "Night (cyan eyes)", weight: 8, colors: { V: "#07101A", E: "#36D6DE", e: "#ECFFFE", M: "#5DE2DF", K: "#C065D0" } },
  { id: "plum", label: "Plum (white eyes)", weight: 4, colors: { V: "#2A0D52", E: "#FFFFFF", e: "#FFFFFF", M: "#E9DDFB", K: "#E07ACD" } },
  {
    id: "lilac",
    label: "Lilac (ink eyes)",
    weight: 4,
    excludes: { palette: ["purple", "purple-orange", "lavender"] },
    colors: { V: "#9457DC", v: "#2B0E57", E: "#0B0614", e: "#FFFFFF", M: "#0B0614", K: "#F7A3DA" },
    colorsXs: { V: "#5E2BA8", E: "#FFFFFF", e: "#FFFFFF", M: "#FFFFFF" }
  }
];
var eyes = [
  { id: "ovals", label: "Ovals", weight: 8, art: { std: face({ 1: "..eE....eE..", 2: "..EE....EE..", 3: "..EE....EE.." }), xs: xsFace({ 1: ".eE..eE.", 2: ".EE..EE." }) } },
  { id: "dots", label: "Dots", weight: 5, art: { std: face({ 2: "..EE....EE..", 3: "..EE....EE.." }), xs: xsFace({ 1: "..E..E..", 2: "..E..E.." }) } },
  { id: "wide", label: "Wide", weight: 4, art: { std: face({ 1: ".eEE....eEE.", 2: ".EEE....EEE.", 3: ".EEE....EEE." }), xs: xsFace({ 1: ".eE..eE.", 2: ".EE..EE.", 3: ".EE..EE." }) } },
  { id: "happy", label: "Happy arcs", weight: 5, art: { std: face({ 2: "..EE....EE..", 3: ".E..E..E..E." }), xs: xsFace({ 1: ".E....E.", 2: "E.E..E.E" }) } },
  { id: "wink", label: "Wink", weight: 3, art: { std: face({ 1: "..eE........", 2: "..EE....EE..", 3: "..EE...E..E." }), xs: xsFace({ 1: ".eE...E.", 2: ".EE..E.E" }) } },
  { id: "sleepy", label: "Sleepy", weight: 2, roles: { critic: 1 }, art: { std: face({ 3: ".EEEE..EEEE." }), xs: xsFace({ 2: "EEE..EEE" }) } },
  { id: "squint", label: "Squint ><", weight: 2, art: { std: face({ 1: ".EE......EE.", 2: "...EE..EE...", 3: ".EE......EE." }), xs: xsFace({ 1: "E......E", 2: ".E....E.", 3: "E......E" }) } },
  { id: "bar", label: "Scanner bar", weight: 2, roles: { critic: 4 }, art: { std: face({ 2: "..eEEEEEEE..", 3: "...EEEEEE..." }), xs: xsFace({ 2: ".EEEEEE." }) } },
  { id: "hearts", label: "Hearts", weight: 1, art: { std: face({ 1: ".K.K....K.K.", 2: ".KKK....KKK.", 3: "..K......K.." }), xs: xsFace({ 1: "K.K..K.K", 2: "KKK..KKK", 3: ".K....K." }) } }
];
var mouths = [
  { id: "smile", label: "Smile", weight: 8, art: { std: face({ 5: "...M....M...", 6: "....MMMM...." }), xs: xsFace({ 4: "..MMMM.." }) } },
  { id: "small", label: "Small smile", weight: 5, art: { std: face({ 5: "....M..M....", 6: ".....MM....." }), xs: xsFace({ 4: "...MM..." }) } },
  { id: "grin", label: "Grin", weight: 3, art: { std: face({ 5: "...MMMMMM...", 6: "....MMMM...." }), xs: xsFace({ 3: "..MMMM..", 4: "...MM..." }) } },
  { id: "cat", label: "Cat ω", weight: 3, art: { std: face({ 5: "...M.MM.M...", 6: "....M..M...." }), xs: xsFace({ 4: "..M..M.." }) } },
  { id: "flat", label: "Flat", weight: 2, roles: { critic: 4 }, art: { std: face({ 6: "....MMMM...." }), xs: xsFace({ 4: "..MMMM.." }) } },
  { id: "o", label: "O", weight: 2, art: { std: face({ 5: ".....MM.....", 6: ".....MM....." }), xs: xsFace({ 4: "...MM..." }) } },
  { id: "none", label: "None", weight: 1, art: { std: face({}), xs: xsFace({}) } }
];
var blushes = [
  { id: "on", label: "Blush", weight: 6, roles: { critic: 3 }, art: { std: face({ 4: "KK........KK" }), xs: xsFace({ 3: "K......K" }) } },
  { id: "none", label: "No blush", weight: 4, art: { std: face({}), xs: xsFace({}) } }
];
var ears = [
  { id: "disc", label: "Metal disc", weight: 7, occupies: ["ears"], art: { std: art([".G", "GG", "GG", "GG", ".G"], [2, 2]), xs: art(["G", "G", "G"], [1, 1]) } },
  { id: "pod", label: "Pod", weight: 5, occupies: ["ears"], art: { std: art([".A", "AA", "AA", "AA", ".A"], [2, 2]), xs: art(["A", "A", "A"], [1, 1]) } },
  { id: "bolt", label: "Bolt", weight: 3, occupies: ["ears"], art: { std: art(["GG", "GG", "GG"], [2, 1]), xs: art(["G", "G"], [1, 1]) } },
  { id: "none", label: "None", weight: 1, art: {} }
];
var antennas = [
  { id: "ball", label: "Ball", weight: 8, occupies: ["top"], roles: { planner: 0, lead: 0 }, art: { std: art([".AA.", "AAAA", ".AA.", ".GG."], [2, 4]), xs: art(["AA", "GG"], [1, 2]) } },
  { id: "dual", label: "Dual", weight: 4, occupies: ["top"], roles: { planner: 0, lead: 0 }, art: { std: art(["AA....AA", ".G....G.", "..G..G.."], [4, 3]), xs: art(["A....A", ".G..G."], [3, 2]) } },
  { id: "bolt", label: "Bolt", weight: 3, occupies: ["top"], roles: { planner: 0, lead: 0, worker: 4 }, art: { std: art(["..TT", ".TT.", "TTTT", ".TT."], [2, 4]), xs: art([".T", "TT", "T."], [1, 3]) } },
  { id: "tab", label: "Tab", weight: 3, occupies: ["top"], roles: { planner: 0, lead: 0 }, art: { std: art([".AAAA.", "AAAAAA"], [3, 2]), xs: art(["AAAA"], [2, 1]) } },
  { id: "dish", label: "Dish", weight: 2, occupies: ["top"], roles: { planner: 0, lead: 0, critic: 6 }, art: { std: art(["G....G", "GG..GG", ".GGGG.", "..GG.."], [3, 4]), xs: art(["G..G", ".GG."], [2, 2]) } },
  { id: "none", label: "None", weight: 3, roles: { planner: 0, lead: 0 }, art: {} },
  { id: "crown", label: "Crown (planner)", weight: 0, keep: true, occupies: ["top"], roles: { planner: 1 }, art: { std: art(["T..TT..T", "TT.TT.TT", "TTTEETTT", "TTTTTTTT"], [4, 3]), xs: art(["T.TT.T", "TTTTTT"], [3, 2]) } },
  { id: "flag", label: "Flag (lead)", weight: 0, keep: true, occupies: ["top"], roles: { lead: 1 }, art: { std: art(["...GTTTT", "...GTTT.", "...GTTTT", "...G...."], [4, 4]), xs: art(["GTT", "GT.", "G.."], [1, 3]) } }
];
var ROUND_TOPS = ["dome", "round", "capsule", "octagon"];
var accessories = [
  { id: "none", label: "None", weight: 10, art: {} },
  {
    id: "cap",
    label: "Cap",
    weight: 2,
    roles: { worker: 3, planner: 0, lead: 0 },
    occupies: ["top"],
    requires: { head: ROUND_TOPS },
    art: {
      std: art(["......TTTTTT........", "....TTTTTTTTTT......", "...TTTTTTTTTTTT.....", "..TTTTTTTTTTTTTT....", ".TTTTTTTTTTTTTTTTTTT", "..tttttttttttttt...."], [9, 2]),
      xs: art(["....TTTT.....", "..TTTTTTTT...", ".TTTTTTTTTTTT"], [6, 1])
    }
  },
  {
    id: "hardhat",
    label: "Hard hat",
    weight: 1,
    roles: { worker: 3, planner: 0, lead: 0, critic: 0 },
    occupies: ["top"],
    art: {
      std: art(["......TTTTTT......", "....TTTTTTTTTT....", "...TTTTTTTTTTTT...", "..TTTTTTTTTTTTTT..", "..TTTTTTTTTTTTTT..", "tttttttttttttttttt"], [9, 2]),
      xs: art(["...TTTTTT...", "..TTTTTTTT..", "tttttttttttt"], [6, 2])
    }
  },
  {
    id: "headlamp",
    label: "Headlamp",
    weight: 2,
    roles: { worker: 3, planner: 0, lead: 0 },
    occupies: ["top"],
    art: { std: art([".GGGG.", "GGWWGG", "GWFFWG", "GGWWGG", ".GGGG."], [3, 3]), xs: art([".GG.", "GWWG", ".GG."], [2, 2]) }
  },
  {
    id: "party",
    label: "Party hat",
    weight: 1,
    roles: { planner: 0, lead: 0 },
    occupies: ["top"],
    art: { std: art(["...WW...", "...TT...", "..AAAA..", "..TTTT..", ".TTTTTT."], [4, 4]), xs: art([".WW.", ".TT.", "TTTT"], [2, 3]) }
  },
  {
    id: "bow",
    label: "Bow",
    weight: 2,
    roles: { critic: 1 },
    occupies: ["side"],
    attach: "side",
    art: { std: art(["TT...TT", "TTTtTTT", "TTTtTTT", "TT...TT"], [3, 2]), xs: art(["T.T", "TtT", "T.T"], [1, 1]) }
  },
  {
    id: "monocle",
    label: "Monocle",
    weight: 0,
    roles: { critic: 6, other: 1 },
    occupies: ["eyeR"],
    attach: "visor",
    requires: { eyes: ["ovals", "dots"] },
    art: {
      std: art([".......GGGG.", ".......G..G.", ".......G..G.", ".......G..G.", ".......GGGG.", "..........G.", "..........G."], [0, 0]),
      xs: art(["....GGGG", "....G..G", "....G..G", "....GGGG"], [0, 0])
    }
  },
  {
    id: "headphones",
    label: "Headphones",
    weight: 1,
    roles: { critic: 2, planner: 0, lead: 0 },
    occupies: ["top", "ears"],
    art: {
      std: art([
        "......GGGGGGGGGG......",
        "....GG..........GG....",
        "...G..............G...",
        "..G................G..",
        "..G................G..",
        ".G..................G.",
        ".G..................G.",
        "AAA................AAA",
        "AAA................AAA",
        "AAA................AAA",
        "AAA................AAA",
        "AAA................AAA",
        ".A..................A."
      ], [11, 2]),
      xs: art(["....GGGGGG....", "..GG......GG..", ".G..........G.", ".G..........G.", "AA..........AA", "AA..........AA", "AA..........AA"], [7, 2])
    }
  }
];
var torsos = [
  {
    id: "round",
    label: "Round",
    weight: 5,
    art: {
      small: art(["......BBBBBBBBBB......", "AA...BBBBBBBBBBBB.....", "AA...BBBBBBBBBBBB...AA", "AA...BBBBBBBBBBBB...AA"], [11, 0], { neck: [11, 0], plate: [7, 1] }),
      full: art(sym(["..BBBBB", ".BBBBBB", "BBBBBBB", "BBBBBBB", "BBBBBBB", ".BBBBBB", "..BBBBB"]), [7, 0], { neck: [7, 0], plate: [3, 1], armL: [0, 1], armR: [14, 1], hip: [7, 7] })
    }
  },
  {
    id: "box",
    label: "Box",
    weight: 4,
    art: {
      small: art([".....BBBBBBBBBBBB.....", "AA...BBBBBBBBBBBB.....", "AA...BBBBBBBBBBBB...AA", "AA...BBBBBBBBBBBB...AA"], [11, 0], { neck: [11, 0], plate: [7, 1] }),
      full: art(sym([".BBBBBB", "BBBBBBB", "BBBBBBB", "BBBBBBB", "BBBBBBB", "bbbbbbb", ".BBBBBB"]), [7, 0], { neck: [7, 0], plate: [3, 1], armL: [0, 1], armR: [14, 1], hip: [7, 7] })
    }
  },
  {
    id: "slim",
    label: "Slim",
    weight: 3,
    art: {
      small: art([".......BBBBBBBB.......", "AA.....BBBBBBBB.......", "AA.....BBBBBBBB.....AA", "AA.....BBBBBBBB.....AA"], [11, 0], { neck: [11, 0], plate: [7, 1] }),
      full: art(sym([".BBBBB", "BBBBBB", "BBBBBB", "BBBBBB", "BBBBBB", "BBBBBB", ".BBBBB"]), [6, 0], { neck: [6, 0], plate: [2, 1], armL: [-1, 1], armR: [13, 1], hip: [6, 7] })
    }
  }
];
var plates = [
  { id: "heart", label: "Heart", weight: 5, art: { small: art(["PLLPPLLP", "PLLLLLLP", "PPPLLPPP"], [0, 0]), full: art(["PLLPPLLP", "PLLLLLLP", "PLLLLLLP", "PPLLLLPP", "PPPLLPPP"], [0, 0]) } },
  { id: "logo", label: "capcomd mark", weight: 4, roles: { planner: 8, lead: 6 }, art: { small: art(["PPLLLLPP", "PLPLLPLP", "PPLLLLPP"], [0, 0]), full: art(["PPLLLLPP", "PLPPPPLP", "PLPLLPLP", "PLPPPPLP", "PPLLLLPP"], [0, 0]) } },
  { id: "letter", label: "Letter block", weight: 4, art: { small: art(["PPPPPPPP", "PPLLLLPP", "PPPPPPPP"], [0, 0]), full: art(["PPPPPPPP", "PPPPPPPP", "PPPPPPPP", "PPPPPPPP", "PPPPPPPP"], [0, 0]) } },
  { id: "screen", label: "Pulse screen", weight: 3, art: { small: art(["PPPFPPPP", "FFFPFPFF", "PPPPPFPP"], [0, 0]), full: art(["PPPPPPPP", "PPPFPPPP", "FFFPFPFF", "PPPPPFPP", "PPPPPPPP"], [0, 0]) } },
  { id: "vent", label: "Vent", weight: 3, art: { small: art(["PLLLLLLP", "PPPPPPPP", "PLLLLLLP"], [0, 0]), full: art(["PPPPPPPP", "PLLLLLLP", "PPPPPPPP", "PLLLLLLP", "PPPPPPPP"], [0, 0]) } },
  { id: "none", label: "None", weight: 2, art: {} }
];
var MITT = [".AA.", "AAAA", "AAAA", ".AA."];
var HAND_SIDE = art(MITT, [-3, -1]);
var HAND_SIDE_HI = art(MITT, [-3, 0]);
var HAND_UP = art(["AA.", "AAA", "AAA", ".AA"], [-5, 15]);
var HAND_SPARK = art([".F.", "FWF", ".F.", "...", "AAA", "AAA", ".A."], [-5, 18]);
var poses = [
  { id: "float", label: "Float", weight: 8, arms: [HAND_SIDE_HI, HAND_SIDE] },
  { id: "wave", label: "Wave", weight: 3, arms: [HAND_SIDE_HI, HAND_UP] },
  { id: "spark", label: "Spark", weight: 2, roles: { critic: 4 }, arms: [HAND_SIDE_HI, HAND_SPARK] },
  { id: "cheer", label: "Cheer", weight: 0, arms: [HAND_UP, HAND_UP] }
];
var legs = [
  { id: "boots", label: "Boots", weight: 8, art: { full: art(["..BB....BB..", "..BB....BB..", ".AAAA..AAAA.", "AAAAA..AAAAA"], [6, 0]) } },
  { id: "hover", label: "Hover jet", weight: 2, art: { full: art(["...GGGGGG...", "....FFFF....", ".....FF....."], [6, 0]) } },
  { id: "treads", label: "Treads", weight: 2, roles: { worker: 3 }, art: { full: art([".GGGGGGGGGG.", "GgGgGgGgGgGG", ".GGGGGGGGGG."], [6, 0]) } }
];
var palettes = [
  { id: "orange", label: "Orange (primary)", weight: 1, roles: { planner: 6, lead: 3 }, colors: { body0: "#FFB566", body1: "#FF7410", body2: "#C8530E", accent0: "#FFB566", accent1: "#E8650C", accent2: "#A8420A", trim0: "#9457DC", trim1: "#5E2BA8", deep: "#4A1A06", plateInk: "#FF9A40" } },
  { id: "purple", label: "Purple", weight: 3, roles: { planner: 0, lead: 1, critic: 4 }, colors: { body0: "#CDAAF5", body1: "#9457DC", body2: "#5E2BA8", accent0: "#CDAAF5", accent1: "#8247CC", accent2: "#4E2390", trim0: "#FF7410", trim1: "#C8530E", deep: "#2B0E57", plateInk: "#C59BF5" } },
  { id: "orange-purple", label: "Orange / purple", weight: 3, roles: { planner: 2, lead: 3 }, colors: { body0: "#FFB566", body1: "#FF7410", body2: "#8F4FD6", accent0: "#CDAAF5", accent1: "#9457DC", accent2: "#5E2BA8", trim0: "#9457DC", trim1: "#5E2BA8", deep: "#2B0E57", plateInk: "#FF9A40" } },
  { id: "purple-orange", label: "Purple / orange", weight: 3, roles: { planner: 0, lead: 2 }, colors: { body0: "#CDAAF5", body1: "#9457DC", body2: "#D2601A", accent0: "#FFB566", accent1: "#FF7410", accent2: "#C8530E", trim0: "#FF7410", trim1: "#C8530E", deep: "#2B0E57", plateInk: "#FF9A40" } },
  { id: "lavender", label: "Lavender", weight: 2, roles: { planner: 0, lead: 1, critic: 3 }, colors: { body0: "#F1E8FF", body1: "#BFA3F5", body2: "#8A6AD6", accent0: "#FFB566", accent1: "#FF7410", accent2: "#C8530E", trim0: "#FF7410", trim1: "#C8530E", deep: "#3A2470", plateInk: "#FFFFFF" } },
  { id: "steel", label: "Steel", weight: 2, roles: { planner: 0, lead: 1 }, colors: { body0: "#DADDE8", body1: "#9EA3B7", body2: "#62677C", accent0: "#FFB566", accent1: "#FF7410", accent2: "#C8530E", trim0: "#FF7410", trim1: "#C8530E", deep: "#262938", plateInk: "#36D6DE" } },
  { id: "ivory", label: "Ivory", weight: 2, roles: { planner: 0, lead: 1 }, colors: { body0: "#FFFFFF", body1: "#ECE6F5", body2: "#B4A9CB", accent0: "#CDAAF5", accent1: "#9457DC", accent2: "#5E2BA8", trim0: "#9457DC", trim1: "#5E2BA8", deep: "#3B2A5C", plateInk: "#C59BF5" } }
];
var dithers = [
  { id: "checker", label: "Checker", weight: 5, style: "checker" },
  { id: "bayer", label: "Bayer 4×4", weight: 4, style: "bayer" },
  { id: "scan", label: "Scanline", weight: 2, style: "scan" },
  { id: "flat", label: "Flat (two-tone)", weight: 2, style: "flat" }
];
var NAMES = [
  "Bolt",
  "Pixel",
  "Widget",
  "Sprocket",
  "Nova",
  "Byte",
  "Chip",
  "Gizmo",
  "Ziggy",
  "Dot",
  "Echo",
  "Fuse",
  "Glint",
  "Jolt",
  "Kilo",
  "Lumen",
  "Mote",
  "Nib",
  "Orbit",
  "Piston",
  "Quark",
  "Servo",
  "Tock",
  "Volt",
  "Watt",
  "Zap",
  "Cog",
  "Diode",
  "Ember",
  "Flux",
  "Gear",
  "Hex",
  "Ion",
  "Joule",
  "Knob",
  "Lever",
  "Mica",
  "Nano",
  "Ohm",
  "Probe",
  "Rotor",
  "Spark",
  "Vector",
  "Wren",
  "Yoyo",
  "Axel",
  "Blip",
  "Cosmo",
  "Dynamo",
  "Ferro",
  "Gadget",
  "Hopper",
  "Jinx",
  "Kit",
  "Loop",
  "Moxie",
  "Nugget",
  "Pip",
  "Radar",
  "Socket",
  "Tinker",
  "Ultra",
  "Vim",
  "Zed"
];
var GLYPHS = {
  A: [".##.", "#..#", "####", "#..#", "#..#"],
  B: ["###.", "#..#", "###.", "#..#", "###."],
  C: [".###", "#...", "#...", "#...", ".###"],
  D: ["###.", "#..#", "#..#", "#..#", "###."],
  E: ["####", "#...", "###.", "#...", "####"],
  F: ["####", "#...", "###.", "#...", "#..."],
  G: [".###", "#...", "#.##", "#..#", ".###"],
  H: ["#..#", "#..#", "####", "#..#", "#..#"],
  I: ["####", ".##.", ".##.", ".##.", "####"],
  J: ["..##", "...#", "...#", "#..#", ".##."],
  K: ["#..#", "#.#.", "##..", "#.#.", "#..#"],
  L: ["#...", "#...", "#...", "#...", "####"],
  M: ["#..#", "####", "####", "#..#", "#..#"],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  O: [".##.", "#..#", "#..#", "#..#", ".##."],
  P: ["###.", "#..#", "###.", "#...", "#..."],
  Q: [".##.", "#..#", "#..#", "#.##", ".###"],
  R: ["###.", "#..#", "###.", "#.#.", "#..#"],
  S: [".###", "#...", ".##.", "...#", "###."],
  T: ["####", ".##.", ".##.", ".##.", ".##."],
  U: ["#..#", "#..#", "#..#", "#..#", ".##."],
  V: ["#..#", "#..#", "#..#", ".##.", ".##."],
  W: ["#..#", "#..#", "####", "####", "#..#"],
  X: ["#..#", "#..#", ".##.", "#..#", "#..#"],
  Y: ["#..#", "#..#", ".##.", ".##.", ".##."],
  Z: ["####", "...#", ".##.", "#...", "####"]
};
var CATALOG = {
  format: "bot-catalog/1",
  frames: {
    xs: { w: 14, h: 14, head: [1, 4], outline: false, shadow: false, uses: ["xs"], shading: "flat" },
    small: { w: 24, h: 24, head: [3, 5], outline: true, shadow: false, uses: ["small", "std"], shading: "auto" },
    full: { w: 32, h: 32, head: [7, 5], outline: true, shadow: true, uses: ["full", "std"], shading: "auto" }
  },
  constants: { metal0: "#BDB7BC", metal1: "#857D81", metal2: "#4F494C", ink: "#0E0818", flame: "#36D6DE", white: "#FFFFFF", shadow: "#00000059" },
  slots: { palette: palettes, antenna: antennas, accessory: accessories, head: heads, ears, screen: screens, eyes, mouth: mouths, blush: blushes, torso: torsos, plate: plates, pose: poses, legs, dither: dithers },
  names: NAMES,
  glyphs: GLYPHS,
  ground: art([[4, 17], [1, 20], [3, 18]].map(([a, b], r) => Array.from({ length: 22 }, (_, c) => c >= a && c <= b && (c + r) % 2 === 0 ? "S" : ".").join("")), [11, 3]),
  bayer4: [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
};
// packages/bot-avatar/src/marks.ts
var MENU_BAR_MARK = [
  "................",
  "................",
  "....########....",
  "..############..",
  ".##############.",
  ".###........###.",
  ".##..##..##..##.",
  ".##..##..##..##.",
  ".##..........##.",
  ".##...####...##.",
  ".###........###.",
  ".##############.",
  "..############..",
  "...##########...",
  "................",
  "................"
];
function markSvg(rows, o = {}) {
  const s = o.scale ?? 1, w = rows[0].length, h = rows.length;
  let d = "";
  rows.forEach((r, y) => {
    for (let x = 0;x < w; ) {
      if (r[x] !== "#") {
        x++;
        continue;
      }
      let n = 1;
      while (r[x + n] === "#")
        n++;
      d += `M${x} ${y}h${n}v1h-${n}z`;
      x += n;
    }
  });
  const a11y = o.label ? `role="img" aria-label="${o.label.replace(/[&<>"']/g, "")}"` : `aria-hidden="true"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * s}" height="${h * s}" shape-rendering="crispEdges" ${a11y}><path fill="${o.color ?? "currentColor"}" d="${d}"/></svg>`;
}
// packages/bot-avatar/src/hash.ts
var encoder = new TextEncoder;
function fnv1a32(bytes) {
  let h = 2166136261;
  for (const b of bytes)
    h = Math.imul(h ^ b, 16777619) >>> 0;
  return h >>> 0;
}
function fmix32(x) {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
var SEP = "\x1F";
function h32(s) {
  return fmix32(fnv1a32(encoder.encode(s)));
}
function hkey(...parts) {
  return h32(parts.join(SEP));
}
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1) >>> 0;
    t = (t ^ t + (Math.imul(t ^ t >>> 7, t | 61) >>> 0)) >>> 0;
    return (t ^ t >>> 14) >>> 0;
  };
}
function rng(seed, stream) {
  return mulberry32(hkey(seed, stream));
}
// packages/bot-avatar/src/engine.ts
function normalizeRole(role) {
  const r = (role ?? "").trim().toLowerCase();
  return ROLES.includes(r) ? r : "other";
}
function weightOf(part, role) {
  return part.roles?.[role] ?? part.weight ?? 4;
}
function compatible(cand, slot, chosen) {
  for (const [s, p] of chosen) {
    if (p.excludes?.[slot]?.includes(cand.id))
      return false;
    if (cand.excludes?.[s]?.includes(p.id))
      return false;
    const pr = p.requires?.[slot];
    if (pr && !pr.includes(cand.id))
      return false;
    const cr = cand.requires?.[s];
    if (cr && !cr.includes(p.id))
      return false;
    if (cand.occupies && p.occupies && cand.occupies.some((z) => p.occupies.includes(z)))
      return false;
  }
  return true;
}
function rendezvous(seed, slot, cands) {
  let best = -1, bestScore = -1;
  cands.forEach((c, i) => {
    let s = -1;
    for (let k = 0;k < c.w; k++)
      s = Math.max(s, hkey(seed, slot, c.id, k));
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  });
  return best;
}
function candidates(slot, role, chosen, catalog = CATALOG) {
  return catalog.slots[slot].filter((p) => weightOf(p, role) > 0 && compatible(p, slot, chosen));
}
function botName(seed, catalog = CATALOG) {
  return catalog.names[rendezvous(seed, "name", catalog.names.map((n) => ({ id: n, w: 1 })))];
}
function botTraits(seed, role, catalog = CATALOG) {
  const r = normalizeRole(role);
  const chosen = [];
  const out = {};
  for (const slot of SLOTS) {
    if (slot === "name")
      continue;
    const cands = candidates(slot, r, chosen, catalog);
    if (!cands.length)
      throw new Error(`bot-avatar: no ${slot} fits ${JSON.stringify(out)} (${r})`);
    const p = cands[rendezvous(seed, slot, cands.map((c) => ({ id: c.id, w: weightOf(c, r) })))];
    chosen.push([slot, p]);
    out[slot] = p.id;
  }
  return { format: "bot/1", seed, role: r, name: botName(seed, catalog), ...out };
}
function constrainedSlots(catalog = CATALOG) {
  const slots = SLOTS.filter((s) => s !== "name");
  const named = new Set;
  for (const s of slots)
    for (const p of catalog.slots[s]) {
      if (p.occupies?.length)
        named.add(s);
      for (const rel of [p.requires, p.excludes])
        if (rel) {
          named.add(s);
          for (const k of Object.keys(rel))
            named.add(k);
        }
    }
  return slots.filter((s) => named.has(s));
}
function countCombinations(role, catalog = CATALOG) {
  const slots = SLOTS.filter((s) => s !== "name");
  const cons = constrainedSlots(catalog);
  const free = slots.filter((s) => !cons.includes(s)).reduce((n, s) => n * catalog.slots[s].filter((p) => weightOf(p, role) > 0).length, 1);
  const walk = (i, chosen) => {
    if (i === cons.length)
      return 1;
    let n = 0;
    for (const p of catalog.slots[cons[i]])
      if (weightOf(p, role) > 0 && compatible(p, cons[i], chosen))
        n += walk(i + 1, [...chosen, [cons[i], p]]);
    return n;
  };
  return walk(0, []) * free;
}
var MOODS = {
  happy: { eyes: "happy", mouth: "grin" },
  sleepy: { eyes: "sleepy", mouth: "flat" },
  oops: { eyes: "squint", mouth: "o" },
  love: { eyes: "hearts", mouth: "smile" }
};
var part = (slot, id, catalog) => {
  const p = catalog.slots[slot].find((x) => x.id === id);
  if (!p)
    throw new Error(`bot-avatar: unknown ${slot} "${id}"`);
  return p;
};
var chosenOf = (t, catalog) => SLOTS.filter((s) => s !== "name").map((s) => [s, part(s, t[s], catalog)]);
function withOverrides(t, o = {}, catalog = CATALOG) {
  let n = { ...t };
  if (o.mood)
    n = { ...n, ...MOODS[o.mood] };
  if (o.pose) {
    part("pose", o.pose, catalog);
    n.pose = o.pose;
  }
  const rest = (slot) => chosenOf(n, catalog).filter(([s]) => s !== slot);
  if (o.accessory && o.accessory !== n.accessory) {
    const acc = part("accessory", o.accessory, catalog);
    const bare = { ...n, antenna: "none" };
    if (compatible(acc, "accessory", rest("accessory")))
      n.accessory = o.accessory;
    else if (!part("antenna", n.antenna, catalog).keep && compatible(acc, "accessory", chosenOf(bare, catalog).filter(([s]) => s !== "accessory")))
      n = { ...bare, accessory: o.accessory };
  }
  if (!compatible(part("accessory", n.accessory, catalog), "accessory", rest("accessory")))
    n.accessory = "none";
  return n;
}
function withPart(t, slot, id, catalog = CATALOG) {
  part(slot, id, catalog);
  const n = { ...t, [slot]: id };
  const rec = n;
  for (const s of SLOTS) {
    if (s === "name" || s === slot)
      continue;
    const others = () => chosenOf(n, catalog).filter(([x]) => x !== s);
    if (!compatible(part(s, rec[s], catalog), s, others()))
      rec[s] = catalog.slots[s].find((p) => compatible(p, s, others()))?.id ?? rec[s];
  }
  return n;
}
function tone(lx, ly, w, h, x, y, style, bayer) {
  const ny = h > 1 ? Math.floor(ly * 16 / (h - 1)) : 8;
  const nx = w > 1 ? Math.floor(lx * 16 / (w - 1)) : 8;
  const L = 2 * ny + nx;
  const t = bayer[y & 3][x & 3];
  const even = (x + y & 1) === 0;
  let hi, sh;
  switch (style) {
    case "flat":
      hi = L <= 5;
      sh = L >= 40;
      break;
    case "checker":
      hi = L <= 4 || L <= 9 && even;
      sh = L >= 42 || L >= 34 && even;
      break;
    case "bayer":
      hi = L < 11 && (11 - L) * 16 > t * 11;
      sh = L > 31 && (L - 31) * 16 > t * 13;
      break;
    case "scan":
      hi = L <= 6 && (y & 1) === 0;
      sh = L >= 44 || L >= 35 && (y & 1) === 1;
      break;
  }
  return hi ? 0 : sh ? 2 : 1;
}
function artFor(p, size, catalog = CATALOG) {
  for (const k of catalog.frames[size].uses) {
    const a = p.art?.[k];
    if (a)
      return a;
  }
  return;
}
var FACE_KEYS = new Set(["E", "e", "M", "K"]);
function botGrid(traits, size, catalog = CATALOG) {
  const fr = catalog.frames[size];
  const { w: W, h: H } = fr;
  const px = new Array(W * H).fill(-1);
  const kind = new Uint8Array(W * H);
  const palette = [];
  const idx = (hex) => {
    let i = palette.indexOf(hex);
    if (i < 0) {
      i = palette.length;
      palette.push(hex);
    }
    return i;
  };
  const ch = chosenOf(traits, catalog);
  const get = (s) => ch.find(([x]) => x === s)[1];
  const pal = get("palette").colors, k = catalog.constants;
  const scr = { ...get("screen").colors, ...size === "xs" ? get("screen").colorsXs : undefined };
  const style = fr.shading === "flat" ? "flat" : get("dither").style;
  let clipped = 0, offVisor = 0;
  const onVisor = new Uint8Array(W * H);
  const color = (c, lx, ly, w, h, x, y) => {
    const tn = () => tone(lx, ly, w, h, x, y, style, catalog.bayer4);
    switch (c) {
      case "B":
        return pal[`body${tn()}`];
      case "b":
        return pal.body2;
      case "H":
        return pal.body0;
      case "A":
        return pal[`accent${tn()}`];
      case "a":
        return pal.accent2;
      case "T":
        return pal.trim0;
      case "t":
        return pal.trim1;
      case "P":
        return pal.deep;
      case "L":
        return pal.plateInk;
      case "G":
        return k[`metal${tn()}`];
      case "g":
        return k.metal2;
      case "W":
        return k.white;
      case "I":
        return k.ink;
      case "F":
        return k.flame;
      case "S":
        return k.shadow;
      default: {
        const v = scr[c];
        if (!v)
          throw new Error(`bot-avatar: unknown pixel key "${c}"`);
        return v;
      }
    }
  };
  const draw = (a, at, mirror = false, face = false) => {
    if (!a || !a.rows.length)
      return at;
    const w = a.rows[0].length, h = a.rows.length;
    const an = a.anchor ?? [0, 0];
    const ox = at[0] - (mirror ? w - an[0] : an[0]), oy = at[1] - an[1];
    for (let r = 0;r < h; r++)
      for (let c = 0;c < w; c++) {
        const key = a.rows[r][mirror ? w - 1 - c : c];
        if (key === ".")
          continue;
        const x = ox + c, y = oy + r;
        if (x < 0 || y < 0 || x >= W || y >= H) {
          clipped++;
          continue;
        }
        const i = y * W + x;
        if (face && FACE_KEYS.has(key) && !onVisor[i])
          offVisor++;
        onVisor[i] = key === "V" || face && onVisor[i] ? 1 : 0;
        const sc = mirror ? w - 1 - c : c;
        const rim = key === "V" && scr.v && fr.outline && [[sc - 1, r], [sc + 1, r], [sc, r - 1], [sc, r + 1]].some(([q, s]) => a.rows[s]?.[q] !== "V");
        px[i] = idx(rim ? scr.v : color(key, c, r, w, h, x, y));
        kind[i] = key === "S" ? 2 : 1;
      }
    return [ox, oy];
  };
  const add = (o, p) => [o[0] + p[0], o[1] + p[1]];
  const head = artFor(get("head"), size, catalog);
  const ho = fr.head, ha = head.anchors;
  if (fr.shadow && catalog.ground)
    draw(catalog.ground, [W >> 1, H]);
  const torsoArt = artFor(get("torso"), size, catalog);
  if (torsoArt) {
    const to = draw(torsoArt, add(ho, ha.neck));
    const ta = torsoArt.anchors;
    if (ta.hip)
      draw(artFor(get("legs"), size, catalog), add(to, ta.hip));
    const plate = get("plate");
    const po = draw(artFor(plate, size, catalog), add(to, ta.plate));
    if (plate.id === "letter" && size === "full") {
      const g = catalog.glyphs[traits.name[0].toUpperCase()];
      if (g)
        draw({ rows: g.map((r) => r.replaceAll("#", "L")), anchor: [0, 0] }, add(po, [2, 0]));
    }
    const arms = get("pose").arms;
    if (arms && ta.armL && ta.armR) {
      draw(arms[0], add(to, ta.armL), true);
      draw(arms[1], add(to, ta.armR));
    }
  }
  draw(head, ho);
  const ear = artFor(get("ears"), size, catalog);
  draw(ear, add(ho, ha.earL));
  draw(ear, add(ho, ha.earR), true);
  const vo = add(ho, ha.visor);
  for (const s of ["blush", "eyes", "mouth"])
    draw(artFor(get(s), size, catalog), vo, false, true);
  draw(artFor(get("antenna"), size, catalog), add(ho, ha.top));
  const acc = get("accessory");
  draw(artFor(acc, size, catalog), add(ho, ha[acc.attach ?? "top"]));
  if (fr.outline) {
    const ink = idx(k.ink);
    const edge = [];
    for (let y = 0;y < H; y++)
      for (let x = 0;x < W; x++) {
        const i = y * W + x;
        if (kind[i] === 1)
          continue;
        if (x > 0 && kind[i - 1] === 1 || x < W - 1 && kind[i + 1] === 1 || y > 0 && kind[i - W] === 1 || y < H - 1 && kind[i + W] === 1)
          edge.push(i);
      }
    for (const i of edge)
      px[i] = ink;
  }
  const used = [];
  for (const v of px)
    if (v >= 0 && !used.includes(v))
      used.push(v);
  const remap = new Map(used.map((v, i) => [v, i]));
  return { w: W, h: H, palette: used.map((v) => palette[v]), px: px.map((v) => v < 0 ? -1 : remap.get(v)), clipped, offVisor };
}
function gridRows(g) {
  const rows = [];
  for (let y = 0;y < g.h; y++) {
    let r = "";
    for (let x = 0;x < g.w; x++) {
      const v = g.px[y * g.w + x];
      r += v < 0 ? "." : v.toString(36);
    }
    rows.push(r);
  }
  return rows;
}
var esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function gridRects(g) {
  const out = g.palette.map(() => []);
  const open = new Map;
  for (let y = 0;y < g.h; y++) {
    let x = 0;
    while (x < g.w) {
      const v = g.px[y * g.w + x];
      let n = 1;
      while (x + n < g.w && g.px[y * g.w + x + n] === v)
        n++;
      if (v >= 0) {
        const key = `${v},${x},${n}`, r = open.get(key);
        if (r && r[1] + r[3] === y)
          r[3]++;
        else {
          const nr = [x, y, n, 1];
          out[v].push(nr);
          open.set(key, nr);
        }
      }
      x += n;
    }
  }
  for (const rs of out)
    rs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return out;
}
function gridSvg(g, o) {
  const scale = o.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1 || scale > 16)
    throw new Error("bot-avatar: scale must be an integer 1–16");
  const d = gridRects(g).map((rs) => {
    let s = "", px = 0, py = 0;
    rs.forEach(([x, y, w, h], i) => {
      s += `${i ? `m${x - px} ${y - py}` : `M${x} ${y}`}h${w}v${h}h-${w}z`;
      px = x;
      py = y;
    });
    return s;
  });
  const a11y = o.decorative ? `aria-hidden="true"` : `role="img" aria-label="${esc(o.label)}"`;
  const paths = g.palette.map((hex, i) => {
    const fill = hex.length === 9 ? `fill="${hex.slice(0, 7)}" fill-opacity="${(parseInt(hex.slice(7), 16) / 255).toFixed(2)}"` : `fill="${hex}"`;
    return `<path ${fill} d="${d[i]}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.w} ${g.h}" width="${g.w * scale}" height="${g.h * scale}" shape-rendering="crispEdges" ${a11y}>${paths.join("")}</svg>`;
}
function botSvg(i, catalog = CATALOG) {
  const t = withOverrides(i.traits ?? botTraits(i.seed, i.role, catalog), i, catalog);
  return gridSvg(botGrid(t, i.size, catalog), { ...i, label: i.label ?? `${t.name}, ${t.role}` });
}
function distinct(a, b) {
  if (a.name === b.name)
    return false;
  const diffs = [a.head !== b.head, a.eyes !== b.eyes, a.antenna !== b.antenna || a.accessory !== b.accessory, a.screen !== b.screen, a.ears !== b.ears].filter(Boolean).length;
  return a.palette !== b.palette ? diffs >= 1 : diffs >= 3;
}
var TEAM_TRIES = 16;
function botTeam(members, catalog = CATALOG) {
  const out = [];
  for (const m of members) {
    let pick = null;
    for (let k = 0;k < TEAM_TRIES && !pick; k++) {
      const t = botTraits(k ? `${m.seed}#${k}` : m.seed, m.role, catalog);
      if (out.every((o) => distinct(o, t)))
        pick = { ...t, seed: m.seed };
    }
    out.push(pick ?? botTraits(m.seed, m.role, catalog));
  }
  return out;
}
export {
  CATALOG,
  MENU_BAR_MARK,
  MOODS,
  ROLES,
  SEP,
  SIZES,
  SLOTS,
  TEAM_TRIES,
  artFor,
  botGrid,
  botName,
  botSvg,
  botTeam,
  botTraits,
  candidates,
  compatible,
  constrainedSlots,
  countCombinations,
  distinct,
  fmix32,
  fnv1a32,
  gridRows,
  gridSvg,
  h32,
  hkey,
  markSvg,
  mulberry32,
  normalizeRole,
  rendezvous,
  rng,
  tone,
  weightOf,
  withOverrides,
  withPart
};
