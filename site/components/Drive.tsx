import type { ReactNode } from "react";
import { SITE } from "@/lib/site";
import { Win, delay } from "./marks";

// README "Connecting your agent" (each row's status as the README states it) and "Quickstart".
const AGENTS: Array<[string, ReactNode, string]> = [
  ["Claude Code", "The capcomd plugin: MCP tools, orchestration and setup skills", "Verified live: a 3-worker swarm with only the plugin's tools"],
  ["Codex", "The same plugin, from the marketplace", "Built to OpenAI's plugin format; not yet tried in Codex"],
  ["Hermes", <><code>capcomd setup agent</code>: the MCP server and the skills, also from its chat gateway</>, "Tested against its documented config; not yet driven live"],
  ["Any MCP client", <><code>capcomd mcp</code>, with bounded waits</>, "Works"],
  ["Any shell agent", <>The CLI: <code>--json</code> on every command (schema <code>relay.v1</code>), stable exit codes</>, "Works, verified live"],
];

export function Drive() {
  return (
    <section className="sec" id="drive" aria-labelledby="dr-title">
      <h2 className="big" id="dr-title" data-reveal><span>Drive it from</span> <span>your agent.</span></h2>
      <div className="dr__grid">
        <div className="dr__table" data-reveal>
          <div className="scroll" tabIndex={0} role="region" aria-label="Agents that drive capcomd">
            <table>
              <thead><tr><th scope="col">Agent</th><th scope="col">How it drives capcomd</th><th scope="col">Today</th></tr></thead>
              <tbody>{AGENTS.map(([a, how, today]) => <tr key={a}><th scope="row">{a}</th><td>{how}</td><td>{today}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="obs">Watching a run: <code>capcomd tui</code> (agent tree, span waterfall, per-agent timelines, cost rollups, event log, live), <code>capcomd logs --follow</code>, <code>capcomd tree</code>, and the macOS menu bar app for runs and approvals (macOS only, built from source for now).</p>
        </div>
        <div className="dr__install" data-reveal style={delay(80)}>
          <Win title="zsh" label="Install, then add the plugin" big>
            <code className="lines">
              <span className="c"># one self-contained executable</span>
              <span>curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh</span>
              <span className="c"># or: brew install MarvinAmador7/tap/capcomd</span>
              <span className="c"># or: bun add -g capcomd</span>
              <span className="c"># then, in Claude Code:</span>
              <span>/plugin install capcomd --marketplace MarvinAmador7/capcomd</span>
            </code>
          </Win>
          <p className="status">Early release (0.x): the primitives, sub-agents, verification, review and durability are built and verified live; expect changes between minor versions. <a href={`${SITE.repo}/blob/main/STATUS.md`}>STATUS.md</a> says what is verified, and how.</p>
        </div>
      </div>
    </section>
  );
}
