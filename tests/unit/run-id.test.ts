// `run new --key K`: the run id is the key within its project (its repository, else its directory).
import { describe, expect, test } from "bun:test";
import { projectIdentity, runIdFor } from "../../src/primitives/ops";

describe("runIdFor", () => {
  test("two projects, one key: two ids; the same project and key: one id", () => {
    const a = runIdFor("tinycalc-run-1", { CAPCOMD_REPO: "https://github.com/acme/tinycalc.git" }, "/x");
    expect(runIdFor("tinycalc-run-1", { CAPCOMD_REPO: "https://github.com/acme/other.git" }, "/x")).not.toBe(a);
    expect(runIdFor("tinycalc-run-1", { CAPCOMD_REPO: "https://github.com/acme/tinycalc.git" }, "/elsewhere")).toBe(a);
    expect(runIdFor("tinycalc-run-2", { CAPCOMD_REPO: "https://github.com/acme/tinycalc.git" }, "/x")).not.toBe(a);
    expect(a).toMatch(/^run-k[0-9a-f]{16}$/);
  });
  test("one repository however its clone URL is spelled", () => {
    const id = (repo: string) => runIdFor("k", { CAPCOMD_REPO: repo }, "/x");
    const a = id("https://github.com/Acme/tinycalc.git");
    for (const u of ["https://github.com/acme/tinycalc", "git@github.com:acme/tinycalc.git", "https://x-access-token:t@github.com/acme/tinycalc.git/", "ssh://git@github.com/acme/tinycalc"]) expect(id(u)).toBe(a);
  });
  test("no repository: the project's directory", () => {
    expect(projectIdentity({ CAPCOMD_NO_CONFIG: "1" }, "/tmp/nowhere-a")).toBe("dir:/tmp/nowhere-a");
    expect(runIdFor("k", {}, "/tmp/nowhere-a")).not.toBe(runIdFor("k", {}, "/tmp/nowhere-b"));
  });
});
