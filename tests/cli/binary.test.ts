// The single executable (scripts/build-binary.ts, install.sh, `capcomd upgrade`): the pure parts. The binary itself is
// built and driven in CI (the binary job) and by the release workflow on every platform.
import { describe, expect, test } from "bun:test";
import { selfArgv, CLI_ENTRY, VERSION } from "../../src/utils/self";
import { COMPILED } from "../../src/utils/home";
import { assetName, installKind, olderThan } from "../../src/cli/commands/upgrade";
import { bunTarget, platformPackages } from "../../scripts/build-binary";
import pkg from "../../package.json" with { type: "json" };

describe("single executable", () => {
  test("from source capcomd runs itself as bun + the CLI entry; the version is compiled in", () => {
    expect(COMPILED).toBe(false);
    expect(selfArgv("serve", "--port", "1")).toEqual([process.execPath, CLI_ENTRY, "serve", "--port", "1"]);
    expect(CLI_ENTRY).toEndWith("src/cli/index.ts");
    expect(VERSION).toBe(pkg.version);
  });
  test("upgrade: install kinds, asset names, version order", () => {
    expect(installKind("/x/capcomd", false)).toBe("checkout"); // this repository
    expect(installKind("/opt/homebrew/Cellar/capcomd/0.6.0/bin/capcomd", true)).toBe("homebrew");
    expect(installKind("/home/me/.capcomd/bin/capcomd", true)).toBe("binary");
    expect(assetName("darwin", "arm64")).toBe("capcomd-darwin-arm64");
    expect(assetName("linux", "x64")).toBe("capcomd-linux-x64");
    expect(() => assetName("win32", "x64")).toThrow(/no capcomd build/);
    expect(olderThan("0.5.0", "0.6.0")).toBe(true);
    expect(olderThan("0.10.0", "0.9.9")).toBe(false);
    expect(olderThan("0.6.0-rc.1", "0.6.0")).toBe(true);
    expect(olderThan("0.6.0", "0.6.0")).toBe(false);
  });
  test("build targets map to rivetkit's platform packages and Bun's compile targets", () => {
    expect(platformPackages("darwin-arm64")).toEqual({ napi: "@rivetkit/rivetkit-napi-darwin-arm64", engine: "@rivetkit/engine-cli-darwin-arm64" });
    expect(platformPackages("linux-x64")).toEqual({ napi: "@rivetkit/rivetkit-napi-linux-x64-gnu", engine: "@rivetkit/engine-cli-linux-x64-musl" });
    expect(bunTarget("linux-x64")).toBe("bun-linux-x64-baseline");
    expect(bunTarget("darwin-x64")).toBe("bun-darwin-x64");
  });
});
