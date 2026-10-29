import { InstallFlow } from "./AgentInstall";
import { HeroCrew } from "./crew";
import { delay } from "./marks";
import { Nav } from "./Nav";
import { SITE } from "@/lib/site";

export function Hero() {
  return (
    <header className="hero">
      <Nav />

      <h1 className="sentence">
        <span className="w" style={{ ["--i" as string]: 0 }}>Put a</span>{" "}
        <span className="slot"><span className="sr">crew</span><span className="floor" aria-hidden="true" /><HeroCrew /></span>
        <br className="phone" />{" "}
        <span className="w" style={{ ["--i" as string]: 1 }}>on it.</span>
      </h1>

      <div className="hero__foot">
        <p className="hero__lead" data-load style={delay(420)}>
          Your coding agent (Claude Code, Codex or Hermes) spawns a crew of agents, each in its own VM or container on its own branch. Only the commit that passed your checks and a reviewer agent lands, exactly once, even if the engine crashes mid-merge.
        </p>
        <div className="hero__install" data-load style={delay(500)} id="install">
          <InstallFlow />
          <a className="button hero__oss" href={SITE.repo}>View on GitHub</a>
        </div>
        <p className="hero__fine" data-load style={delay(560)}>Open source. One executable for macOS and Linux. Claude Code is verified live; the Codex and Hermes setups are built.</p>
      </div>
    </header>
  );
}
