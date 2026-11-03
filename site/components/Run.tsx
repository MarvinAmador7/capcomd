// "Spawn, await, verify, merge": the run's mechanics, as five stages whose pictures are the capcomd menu bar app
// (rebuilt from apps/menubar/design at true size; illustrations, not captures).
import type { ReactNode } from "react";
import { AgentSuffix, Bot, GoalComposer, GoalTitle, TryGoals } from "./crew";
import { Durable } from "./Durable";
import { RunAccordion, type Stage } from "./RunAccordion";
import { Check, Hand, MarkFace, MenuBar, delay, step } from "./marks";

function Desk({ label, children }: { label?: string; children: ReactNode }) {
  // A panel is a picture of the app: described once, its insides hidden from assistive tech. The Ask panel holds
  // a real text field, so it is not an image.
  return label
    ? <div className="desk" role="img" aria-label={label}><MenuBar /><div className="panel" data-ui aria-hidden="true">{children}</div><span className="floor" aria-hidden="true" /></div>
    : <div className="desk"><MenuBar /><div className="panel" data-ui data-join style={step(0)}>{children}</div><span className="floor" aria-hidden="true" /></div>;
}

const Ring = () => <span className="status-ring" />;
const Worker = ({ i }: { i: number }) => <span>worker<span className="sub"><AgentSuffix i={i} /></span></span>;

const stages: Stage[] = [
  {
    id: "ask", name: "Ask", face: <MarkFace />,
    text: <div><p>Your project sets the gates once: which checks run, which reviewer reads the work, which branch it lands on. Your agent picks checks by name and can set a budget or a staging branch; it never writes the commands.</p><TryGoals /></div>,
    picture: (
      <Desk>
        <div className="composer">
          <span className="chips" aria-hidden="true"><span className="chip">my-app</span><span className="keycap">⌘K</span></span>
          <GoalComposer />
          <span className="tools" aria-hidden="true">
            <span className="tool">+</span>
            <span className="seg">
              <span className="on"><svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="7" rx="1.2" fill="none" stroke="var(--color-app-text)" strokeWidth="1.3" /><path d="M1 12.5h14" stroke="var(--color-app-text)" strokeWidth="1.3" strokeLinecap="round" /></svg></span>
              <span><svg viewBox="0 0 16 16"><path d="M4.5 12.5h7.2a2.8 2.8 0 0 0 .3-5.6A4 4 0 0 0 4.3 6 3.3 3.3 0 0 0 4.5 12.5Z" fill="none" stroke="var(--color-app-text)" strokeWidth="1.3" strokeLinejoin="round" /></svg></span>
            </span>
            <span className="chip driver">Claude Code ⌄</span>
            <span className="send"><svg viewBox="0 0 14 14"><path d="M7 11.5V2.5M3 6.5 7 2.5l4 4" fill="none" stroke="var(--color-app-ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
          </span>
        </div>
        <div className="label">Recent</div>
        <div className="recent">
          <div className="rrow"><Bot i={0} size="small" className="tile" /><span><b>Add rate limiting to the API</b><small>Merged into main</small></span><span className="keycap">⌘1</span></div>
        </div>
      </Desk>
    ),
  },
  {
    id: "swarm", name: "Swarm", face: <Bot i={0} size="small" />,
    text: <><p>Each task gets a fresh VM with its own clone and branch, and a profile: provider, login, model, limits, tools. A spawn retried after a crash never starts a second agent.</p><p className="stage__cmd"><code>spawn --profile worker --task … --check unit --key …</code></p></>,
    picture: (
      <Desk label="The menu bar panel as a run starts: the planner above three workers.">
        <div className="label" style={{ marginTop: 6 }}>Active</div>
        <div className="card"><div className="card__in">
          <div className="card__top"><span className="card__title g"><GoalTitle /></span><span className="t">0:12</span></div>
          <div className="meet">
            <Bot i={0} pose="wave" className="bot boss" join style={step(0)} />
            <span className="trace" data-join style={step(1)} />
            <div className="row">
              {[1, 2, 3].map((i) => <span key={i} className="kid" data-join style={step(i + 1)}><Bot i={i} className="bot" />worker<small><AgentSuffix i={i} /></small></span>)}
            </div>
          </div>
          <div className="line"><Ring /><span><b>planner</b> is splitting the work across 3 workers</span></div>
        </div></div>
      </Desk>
    ),
  },
  {
    id: "verify", name: "Verify", face: <Bot i={1} size="small" />,
    text: <><p>Your test command runs on the agent&apos;s branch merged with the latest target, in a throwaway VM with no credentials. Agents choose a check by name; they can never write one.</p><p className="stage__cmd"><code>verify --ref agt</code></p></>,
    picture: (
      <Desk label="The menu bar panel: the agent tree; one worker's unit check passed, one running, one queued.">
        <div className="label" style={{ marginTop: 6 }}>Active</div>
        <div className="card"><div className="card__in">
          <div className="card__top"><span className="card__title g"><GoalTitle /></span><span className="t">2:05</span></div>
          <div className="tree">
            <div className="tr" data-join style={step(0)}><Bot i={0} size="xs" className="ic" /><span>planner</span><span className="st"><Ring /></span></div>
            <div className="tr l2" data-join style={step(1)}><Bot i={1} size="xs" className="ic" /><Worker i={1} /><span className="st"><span className="ok"><Check /></span>unit passed</span></div>
            <div className="tr l2" data-join style={step(2)}><Bot i={2} size="xs" className="ic" /><Worker i={2} /><span className="st"><Ring />unit running</span></div>
            <div className="tr l2" data-join style={step(3)}><Bot i={3} size="xs" className="ic" /><Worker i={3} /><span className="st"><span className="clock" />queued</span></div>
          </div>
        </div></div>
      </Desk>
    ),
  },
  {
    id: "review", name: "Review", face: <Bot i={4} size="small" />,
    text: <><p>A read-only reviewer agent reads the commit against the acceptance criteria; it never pushes. The checks and the review must both pass, and a missing or garbled verdict counts as a fail.</p><p className="stage__cmd"><code>run new --reviewer P</code></p></>,
    picture: (
      <Desk label="The menu bar panel: two workers passed their checks; one reviewer passed, one is reading.">
        <div className="label" style={{ marginTop: 6 }}>Active</div>
        <div className="card"><div className="card__in">
          <div className="card__top"><span className="card__title g"><GoalTitle /></span><span className="t">2:58</span></div>
          <div className="tree">
            <div className="tr" data-join style={step(0)}><Bot i={0} size="xs" className="ic" /><span>planner</span><span className="st"><Ring /></span></div>
            <div className="tr l2" data-join style={step(1)}><Bot i={1} size="xs" className="ic" /><Worker i={1} /><span className="st"><span className="ok"><Check /></span>unit passed</span></div>
            <div className="tr l2" data-join style={step(2)}><Bot i={2} size="xs" className="ic" /><Worker i={2} /><span className="st"><span className="ok"><Check /></span>unit passed</span></div>
            <div className="tr l2" data-join style={step(3)}><Bot i={4} size="xs" className="ic" /><span>reviewer<span className="sub"><AgentSuffix i={4} /></span></span><span className="st"><span className="ok"><Check /></span>pass</span></div>
            <div className="tr l2" data-join style={step(4)}><Bot i={5} size="xs" className="ic" /><span>reviewer<span className="sub"><AgentSuffix i={5} /></span></span><span className="st"><Ring />reading</span></div>
          </div>
        </div></div>
      </Desk>
    ),
  },
  {
    id: "merge", name: "Merge", face: <Bot i={1} size="small" />,
    text: <><p>The exact commit that passed lands, once. Protected branches wait for your approval: from <code>capcomd approve</code>, the capcomd menu bar app, or your agent where the project allows it.</p><p className="stage__cmd"><code>merge --require vfy</code></p></>,
    picture: (
      <Desk label="The menu bar panel asking: merge worker's work into main? Two files with lines added and removed, and Deny and Approve.">
        <div className="label" style={{ marginTop: 6 }}>Active</div>
        <div className="card asks" data-join style={step(0)}>
          <div className="card__in">
            <div className="card__top"><span className="g"><GoalTitle /></span><span className="t">3:41</span></div>
            <p className="q"><Hand />Merge worker&apos;s work into main?</p>
            <div className="who"><Bot i={1} size="xs" className="head" /><span><b>worker</b> asked 18s ago · planner waits on it</span></div>
            <code className="files">
              <span className="f"><span>src/parser.ts</span><span className="add">+11</span><span className="del">−2</span></span>
              <span className="f"><span>src/parser.test.ts</span><span className="add">+6</span><span className="del">−0</span></span>
            </code>
          </div>
          <div className="cbar"><span className="diff">View diff</span><span className="btn btn--deny">Deny</span><span className="btn btn--ok">Approve <kbd>↩</kbd></span></div>
        </div>
      </Desk>
    ),
  },
];

export function Run() {
  return (
    <section className="run" id="run" aria-labelledby="run-title">
      <div className="run__intro">
        <h2 id="run-title" data-reveal><span>Spawn, await,</span> <span>verify, merge.</span></h2>
        <div className="cols">
          <p data-reveal style={delay(80)}>Tell your agent the outcome: &ldquo;Use capcomd to fix the failing tests in <code>src/</code>, one worker per file.&rdquo; It does the rest with five calls: <code>run new</code>, <code>spawn</code>, <code>await</code>, <code>verify</code> and <code>merge</code>.</p>
          <p data-reveal style={delay(140)}>Building blocks, not a fixed workflow. Your agent drives them through the plugin, MCP or the CLI; so can an agent in a VM that may delegate, or you. Spawned agents keep working after your agent&apos;s session ends.</p>
        </div>
      </div>
      <RunAccordion stages={stages} initial="swarm" />
      <Durable />
    </section>
  );
}
