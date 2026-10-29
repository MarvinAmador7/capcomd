import type { ReactNode } from "react";
import { Bot } from "./crew";
import { Win, delay } from "./marks";
import { Talk } from "./Talk";

// The tree that the example agents.json beside it allows, drawn with the hero's crew. lead and triage are example
// profiles added to what `capcomd setup project` writes (src/config/project-setup.ts); the file says so.
const AGENTS_JSON = `{
  "schema": "capcomd.agents/v1",
  "default": "worker",
  "agents": {
    "worker": { "provider": "claude", "auth": "subscription" },
    "codex-worker": { "provider": "codex", "auth": "subscription" },
    "reviewer": {
      "provider": "claude", "auth": "subscription",
      "allowedTools": ["Read", "Glob", "Grep", "LS",
        "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
        "Bash(cat:*)", "Bash(ls:*)", "Bash(bun test:*)"]
    },
    "planner": {
      "provider": "claude", "auth": "subscription",
      "children": {
        "allowSpawn": true,
        "allowedChildProfiles": ["worker", "codex-worker",
                                 "lead", "triage"]
      }
    },
    "lead": {
      "provider": "claude", "auth": "subscription",
      "children": {
        "allowSpawn": true, "maxDepth": 1,
        "allowedChildProfiles": ["worker", "codex-worker"]
      }
    },
    "triage": { "provider": "codex", "auth": "subscription" }
  }
}`;

function Node({ crew, name, example, children, sub }: { crew: number; name: string; example?: boolean; children: ReactNode; sub?: ReactNode }) {
  return (
    <li className={`node${example ? " node--ex" : ""}`}>
      <Bot i={crew} className="bot" />
      <span className="node__txt"><b>{name}</b><span>{children}</span></span>
      {sub}
    </li>
  );
}


export function RoleTree() {
  return (
    <section className="sec roles" id="roles" aria-labelledby="roles-title">
      <h2 className="big" id="roles-title" data-reveal><span>Roles are profiles.</span> <span>Trees are policy.</span></h2>
      <div className="two">
        <p data-reveal>A role is any named profile in <code>.capcomd/agents.json</code>: a provider (Claude Code or Codex), a login (plan or API key), a model and effort, allowed tools, a sandbox, an egress allowlist, limits, and a <code>children</code> block that says whether it may spawn, which profiles, how deep and how wide.</p>
        <p data-reveal style={delay(60)}>So a profile delegates only to the profiles you allow, as deep as you allow, and a parent can only narrow that for its children. <code>capcomd agents schema</code> prints the JSON Schema; <code>agents validate</code> checks a file against it.</p>
      </div>
      <div className="roles__grid">
        <figure className="roletree" data-reveal>
          <ol className="tree__list">
            <li className="node node--root">
              <span className="node__you" aria-hidden="true">›_</span>
              <span className="node__txt"><b>Your agent</b><span>The orchestrator: Claude Code, Codex or Hermes through the plugin, MCP or the CLI. Or an agent in a VM allowed to delegate, or you.</span></span>
              <ol>
                <Node crew={0} name="planner" sub={
                  <ol>
                    <Node crew={6} name="lead" example sub={
                      <ol>
                        <Node crew={7} name="worker">Claude Code, its own VM and branch</Node>
                        <Node crew={8} name="codex-worker">Codex, its own VM and branch</Node>
                      </ol>
                    }>A sub-planner: may spawn the two workers, <code>maxDepth: 1</code></Node>
                    <Node crew={1} name="worker">A leaf: may not spawn</Node>
                    <Node crew={4} name="reviewer">Read-only; the planner&apos;s <code>verify</code> spawns one on each commit it checks; never pushes</Node>
                    <Node crew={9} name="triage" example>Spawned with <code>--report</code>: a read-only checkout; its answer is its result</Node>
                  </ol>
                }><code>allowSpawn</code>, only <code>worker</code>, <code>codex-worker</code>, <code>lead</code> and <code>triage</code></Node>
              </ol>
            </li>
          </ol>
          <figcaption>The tree the file beside it allows, drawn with the hero&apos;s crew. Checks are not a role: they run in their own VM, with no agent.</figcaption>
        </figure>
        <div className="roles__file" data-reveal style={delay(80)}>
          <Win title=".capcomd/agents.json · example" label="Example .capcomd/agents.json"><code className="json" tabIndex={0}>{AGENTS_JSON}</code></Win>
        </div>
      </div>
      <h3 className="talk__title" id="talk" data-reveal>How they talk</h3>
      <Talk />
    </section>
  );
}
