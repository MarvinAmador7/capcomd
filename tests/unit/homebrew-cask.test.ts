// The Homebrew cask the release workflow commits to the tap (scripts/homebrew-cask.ts): the app's zip, no dependency on
// the CLI's formula (the app uses the CLI people already have), and the first-open steps while it isn't notarized.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASK, cask } from "../../scripts/homebrew-cask";

const sha = "a".repeat(64);

describe("homebrew cask", () => {
	test("the release's zip, Sonoma or later, the Open Anyway steps", () => {
		const c = cask("0.10.0", sha);
		expect(CASK).toBe("capcomd-app");
		expect(c).toContain('cask "capcomd-app" do');
		expect(c).toContain('version "0.10.0"');
		expect(c).toContain(`sha256 "${sha}"`);
		expect(c).toContain('url "https://github.com/MarvinAmador7/capcomd/releases/download/v#{version}/capcomd-app-#{version}.zip"');
		expect(c).toContain('depends_on macos: :sonoma');
		expect(c).toContain('app "capcomd.app"');
		expect(c).toContain('uninstall quit: "dev.capcomd.app"');
		expect(c).toContain("System Settings > Privacy & Security");
		expect(c).toContain("Open Anyway");
		expect(c).not.toContain("~/.capcomd");   // zap never takes the CLI's state
	});

	test("it doesn't install a second CLI: no formula dependency, and the caveats say how to get one", () => {
		const c = cask("0.10.0", sha);
		expect(c).not.toMatch(/depends_on\s+formula/);
		expect(c).toContain("brew install MarvinAmador7/tap/capcomd");   // FirstRun.installCommand, as the app shows it
		expect(c).toMatch(/install\.sh, Bun or npm/);
	});

	test("a throwaway tap: a file:// zip", () => {
		const c = cask("0.10.0", sha, { base: "file:///tmp/build" });
		expect(c).toContain('url "file:///tmp/build/capcomd-app-0.10.0.zip"');
	});

	test("the script reads the .sha256 build-app.sh wrote, and refuses a file without one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "capcomd-cask-"));
		try {
			writeFileSync(join(dir, "capcomd-app-0.10.0.zip.sha256"), `${sha}  capcomd-app-0.10.0.zip\n`);
			const ok = Bun.spawnSync(["bun", "scripts/homebrew-cask.ts", "v0.10.0", dir]);
			expect(ok.exitCode).toBe(0);
			expect(ok.stdout.toString()).toBe(cask("0.10.0", sha));
			writeFileSync(join(dir, "capcomd-app-0.10.0.zip.sha256"), "\n");
			expect(Bun.spawnSync(["bun", "scripts/homebrew-cask.ts", "0.10.0", dir]).exitCode).not.toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.if(!!Bun.which("ruby"))("it's valid Ruby", () => {
		const dir = mkdtempSync(join(tmpdir(), "capcomd-cask-"));
		try {
			const f = join(dir, "capcomd-app.rb");
			writeFileSync(f, cask("0.10.0", sha));
			const r = Bun.spawnSync(["ruby", "-c", f]);
			expect(r.stdout.toString()).toContain("Syntax OK");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
