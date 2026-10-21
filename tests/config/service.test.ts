import { describe, expect, test } from "bun:test";
import { LABEL, UNIT, serviceFile, type ServiceSpec } from "../../src/cli/commands/service";

const spec = (platform: NodeJS.Platform): ServiceSpec => ({ platform, bun: "/opt/bun/bin/bun", cli: "/opt/capcomd/src/cli/index.ts", port: 6420, home: "/home/me", logFile: "/home/me/.capcomd/engine.log", path: "/opt/bun/bin:/usr/bin:/bin" });

describe("engine as a service", () => {
  test("macOS: a launchd agent running `capcomd serve`, restarted on crash, logging to ~/.capcomd", () => {
    const f = serviceFile(spec("darwin"));
    expect(f.path).toBe(`/home/me/Library/LaunchAgents/${LABEL}.plist`);
    expect(f.body).toContain("<string>/opt/bun/bin/bun</string><string>/opt/capcomd/src/cli/index.ts</string><string>serve</string><string>--port</string><string>6420</string>");
    expect(f.body).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(f.body).toContain("<key>WorkingDirectory</key><string>/home/me</string>"); // home: only the user config applies
    expect(f.body).toContain("<key>StandardOutPath</key><string>/home/me/.capcomd/engine.log</string>");
    expect(f.body).not.toContain("BOXD_API_KEY"); // the key stays in the keychain
  });
  test("Linux: a systemd user unit, enabled at login, restarted on failure", () => {
    const f = serviceFile(spec("linux"));
    expect(f.path).toBe(`/home/me/.config/systemd/user/${UNIT}`);
    expect(f.body).toContain("ExecStart=/opt/bun/bin/bun /opt/capcomd/src/cli/index.ts serve --port 6420");
    expect(f.body).toContain("Restart=on-failure");
    expect(f.body).toContain("WantedBy=default.target");
    expect(f.body).not.toContain("BOXD_API_KEY");
  });
  test("other platforms are refused with a hint", () => {
    expect(() => serviceFile(spec("win32"))).toThrow(/no background service support/);
  });
});
