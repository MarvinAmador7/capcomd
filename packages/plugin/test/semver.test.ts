// The package's own version order (src/semver.ts `compareVersions`) is Bun's (Bun.semver.order), so the published
// package checks `engines.capcomd` on Node exactly as the daemon does on Bun (spec §4.4).
import { describe, expect, test } from "bun:test";
import { compareVersions, satisfies } from "../src/semver";

const VERSIONS = [
  "0.0.0", "0.0.1", "0.1.0", "0.9.0", "0.9.1", "0.10.0-0", "0.10.0-rc.1", "0.10.0-rc.2", "0.10.0-rc.10", "0.10.0-rc.a",
  "0.10.0-alpha", "0.10.0-alpha.1", "0.10.0-alpha.beta", "0.10.0-beta", "0.10.0-beta.2", "0.10.0-beta.11", "0.10.0",
  "0.10.0+build.5", "1.0.0", "1.0.0-1", "1.0.0-1.2", "2.0.0", "10.0.0", "v1.2.3",
];

describe("compareVersions (§4.4)", () => {
  test("orders every pair as Bun.semver.order does", () => {
    for (const a of VERSIONS) for (const b of VERSIONS) expect([a, b, compareVersions(a, b)]).toEqual([a, b, Bun.semver.order(a, b)]);
  });
  test("semver.org §11's own example sorts in its order", () => {
    const want = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    expect([...want].reverse().sort(compareVersions)).toEqual(want);
  });
  test("ranges admit prereleases, as before", () => {
    expect(satisfies("0.10.0-rc.1", ">=0.9.0 <1.0.0")).toBe(true);
    expect(satisfies("1.0.0", ">=0.9.0 <1.0.0")).toBe(false);
    expect(satisfies("0.9.0", "^0.9.0")).toBe(true);
    expect(satisfies("0.10.0", "^0.9.0")).toBe(false);
  });
});
