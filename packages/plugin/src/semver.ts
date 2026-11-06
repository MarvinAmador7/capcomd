// `engines.capcomd` ranges (spec §4.4): semver range semantics with prereleases included, so `>=0.9.0 <1.0.0` admits
// 0.10.0-rc.1. Bun.semver.satisfies leaves prereleases out (node-semver's default) and accepts any string as a range,
// so the host parses ranges itself and compares versions by semver 2.0 precedence (`compareVersions`: no Bun API, so the
// published package runs on Node too). The grammar is node-semver's common subset: comparators (`>=1.2.0 <2`), `^`, `~`, x-ranges (`1.x`, `1.2`), hyphen ranges (`1.0.0 - 1.4.0`) and `||`.

type Op = ">=" | ">" | "<=" | "<" | "=";
type Comparator = { op: Op; version: string };

const PART = "(0|[1-9]\\d*|[xX*])";
const PARTIAL = new RegExp(`^v?${PART}(?:\\.${PART}(?:\\.${PART}(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?)?)?$`);

type Partial = { major: number | null; minor: number | null; patch: number | null; pre: string };
function partial(s: string): Partial | null {
  const m = PARTIAL.exec(s);
  if (!m) return null;
  const n = (x: string | undefined) => x === undefined || /^[xX*]$/.test(x) ? null : Number(x);
  const major = n(m[1]), minor = major === null ? null : n(m[2]), patch = minor === null ? null : n(m[3]);
  return { major, minor, patch, pre: patch === null ? "" : m[4] ?? "" };
}
const v = (a: number, b: number, c: number, pre = "") => `${a}.${b}.${c}${pre}`;

/** One comparator word (`>=1.2`, `^0.9.0`, `~1.2.3`, `1.x`) as primitive comparators; null when it is not one. */
function desugar(word: string): Comparator[] | null {
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(word);
  if (!m) return null;
  const op = m[1] ?? "", p = partial(m[2]!);
  if (!p) return null;
  const { major, minor, patch, pre } = p;
  if (major === null) return op === "<" || op === ">" ? [{ op: "<", version: "0.0.0-0" }] : [];
  const full = minor !== null && patch !== null;
  const lowest = v(major, minor ?? 0, patch ?? 0, pre);
  // The first version past the partial: 1 → 2.0.0-0, 1.2 → 1.3.0-0.
  const past = minor === null ? v(major + 1, 0, 0, "-0") : v(major, minor + 1, 0, "-0");
  switch (op) {
    case "^": {
      const upper = major > 0 || minor === null ? v(major + 1, 0, 0, "-0") : minor > 0 || patch === null ? v(0, minor + 1, 0, "-0") : v(0, 0, patch + 1, "-0");
      return [{ op: ">=", version: lowest }, { op: "<", version: upper }];
    }
    case "~": return [{ op: ">=", version: lowest }, { op: "<", version: minor === null ? v(major + 1, 0, 0, "-0") : v(major, minor + 1, 0, "-0") }];
    case ">=": return [{ op: ">=", version: lowest }];
    case "<": return [{ op: "<", version: full ? lowest : v(major, minor ?? 0, patch ?? 0, "-0") }];
    case ">": return [{ op: full ? ">" : ">=", version: full ? lowest : past }];
    case "<=": return [{ op: full ? "<=" : "<", version: full ? lowest : past }];
    default: return full ? [{ op: "=", version: lowest }] : [{ op: ">=", version: lowest }, { op: "<", version: past }];
  }
}

/** A range as alternatives (`||`) of comparator sets; null when the text is not a range. */
export function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alt of range.trim().split("||")) {
    const text = alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1");
    if (!text) return null;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const lo = desugar(`>=${hyphen[1]}`), hi = partial(hyphen[2]!);
      if (!lo || !hi || hi.major === null) return null;
      const full = hi.minor !== null && hi.patch !== null;
      sets.push([...lo, full ? { op: "<=", version: v(hi.major, hi.minor!, hi.patch!, hi.pre) } : desugar(`<=${hyphen[2]}`)![0]!]);
      continue;
    }
    const set: Comparator[] = [];
    for (const word of text.split(/\s+/)) {
      const c = desugar(word);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver 2.0 precedence (§11 of semver.org): -1, 0 or 1. Build metadata is ignored; a prerelease sorts before its
 *  release, its identifiers compared numerically when both are numbers, a number before a word, fewer before more.
 *  A string that isn't a version sorts before every version (and equal to another such string). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = VERSION.exec(a.trim()), y = VERSION.exec(b.trim());
  if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1;
  const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0) as -1 | 0 | 1;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return sign(Number(x[i]) - Number(y[i]));
  const p = x[4]?.split("."), q = y[4]?.split(".");
  if (!p || !q) return !p && !q ? 0 : !p ? 1 : -1;
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    const s = p[i], t = q[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    if (s === t) continue;
    const sn = /^\d+$/.test(s), tn = /^\d+$/.test(t);
    // Numbers by value (`00` is `0`, as Bun has it): equal ones go on to the next identifier.
    if (sn && tn) { if (Number(s) !== Number(t)) return sign(Number(s) - Number(t)); continue; }
    if (sn !== tn) return sn ? -1 : 1;
    return s < t ? -1 : 1;
  }
  return 0;
}

const TEST: Record<Op, (o: number) => boolean> = { ">=": (o) => o >= 0, ">": (o) => o > 0, "<=": (o) => o <= 0, "<": (o) => o < 0, "=": (o) => o === 0 };

/** Whether `version` is in `range`, prereleases compared like any version (§4.4). False for a range that doesn't parse. */
export function satisfies(version: string, range: string): boolean {
  const sets = parseRange(range);
  if (!sets) return false;
  return sets.some((set) => set.every((c) => TEST[c.op](compareVersions(version, c.version))));
}
