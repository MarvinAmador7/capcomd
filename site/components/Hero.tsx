import { HeroCrew, RedrawButton, RunId } from "./crew";
import { Win, Wordmark, delay } from "./marks";
import { SITE } from "@/lib/site";

const NAV = [["#run", "Run"], ["#sandboxes", "Sandboxes"], ["#roles", "Roles"], ["#scale", "At scale"], ["#patterns", "Patterns"]] as const;

export function Hero({ version }: { version: string }) {
  return (
    <header className="hero">
      <nav className="nav" aria-label="Main">
        <Wordmark className="nav__mark" />
        <ul className="nav__links m-0 list-none p-0">
          {NAV.map(([href, label]) => <li key={href}><a href={href}>{label}</a></li>)}
          <li><a href={SITE.repo}>GitHub</a></li>
        </ul>
        <a className="button" href="#install">Install</a>
      </nav>

      <h1 className="sentence">
        <span className="w" style={{ ["--i" as string]: 0 }}>Put a</span>{" "}
        <span className="slot"><span className="sr">crew</span><span className="floor" aria-hidden="true" /><HeroCrew /></span>
        <br className="phone" />{" "}
        <span className="w" style={{ ["--i" as string]: 1 }}>on it.</span>
      </h1>

      <div className="hero__foot">
        <p className="hero__lead" data-load style={delay(420)}>
          <b>capcomd</b> is durable orchestration for swarms of coding agents. Your coding agent drives it: Claude Code and Codex agents run in parallel, each in its own VM on its own branch, and only the exact commit that passed your checks and a reviewer agent merges, once.
        </p>
        <div className="hero__do" data-load style={delay(500)} id="install">
          <a className="button" href={`${SITE.repo}#quickstart`}>Install capcomd</a>
          <a className="text" href={SITE.repo}>Read the README</a>
        </div>
        <div className="hero__note" data-load style={delay(620)}>
          <p className="m-0">Crew drawn from <RunId />; every agent&apos;s bot is seeded by its id. <RedrawButton />MIT. Early release, {version}. One executable for macOS and Linux, arm64 and x64.</p>
          <Win title="zsh" label="Install with Homebrew"><code tabIndex={0}>brew install MarvinAmador7/tap/capcomd</code></Win>
        </div>
      </div>
    </header>
  );
}
