import { AgentInstall } from "./AgentInstall";
import { HeroCrew } from "./crew";
import { Win, delay } from "./marks";
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
          <b>capcomd</b> is a durable orchestration CLI and MCP server for swarms of coding agents running on cloud VMs.
        </p>
        <div className="hero__note" data-load style={delay(500)} id="install">
          <AgentInstall />
          <Win title="zsh" label="Install with Homebrew"><code tabIndex={0}>brew install MarvinAmador7/tap/capcomd</code></Win>
          <p className="hero__fine">Open source. One executable for macOS and Linux.</p>
        </div>
        <div className="hero__do" data-load style={delay(620)}>
          <a className="button" href={SITE.repo}>OSS Project</a>
        </div>
      </div>
    </header>
  );
}
