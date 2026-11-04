// `capcomd <command> … --help` prints that command's usage, not the whole help.
import { describe, expect, test } from "bun:test";
import { capcomd } from "../helpers/engine";

describe("--help", () => {
  test("setup project --help: setup's usage and flags only", async () => {
    const r = await capcomd(["setup", "project", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("capcomd setup [demo|accounts|project|agent|service]");
    expect(r.stdout).toContain("[--sandbox docker|boxd]");
    expect(r.stdout).toContain("capcomd setup check");
    expect(r.stdout).not.toContain("capcomd serve");
    expect(r.stdout).toContain("capcomd --help");
  });
  test("--help alone, or with a command the help doesn't name: the whole help", async () => {
    for (const args of [["--help"], ["nonesuch", "--help"]]) {
      const r = await capcomd(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("capcomd serve");
      expect(r.stdout).toContain("Exit codes:");
    }
  });
});
