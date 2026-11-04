// Three ideas, three tiles: one agent's column with its ask docked at the foot, the keys that move you around, and
// the title bar with the other projects folded into decks (one of them asking). Static crops of the window, rebuilt
// from the approved boards (Reel.png, ReelStack); the keys are the desktop SPEC's §4.
import { CREW, ASK } from "@/lib/desktop";
import { delay } from "../marks";
import { Bot, ColumnHead, Decision, Icon, Thread } from "./parts";

const PLANNER = CREW.find((a) => a.id === "planner")!;
const KEYCAPS: Array<{ keys: string[]; what: string }> = [
  { keys: ["⌘", "1"], what: "Open a project" },
  { keys: ["⌃", "→"], what: "Next agent" },
  { keys: ["↩"], what: "Approve" },
];
const H = (seed: string, role: string) => ({ seed, role });
const MATCHKEY = [H("dk-98", "planner"), H("dk-47", "lead"), H("dk-8", "worker"), H("dk-88", "worker")];
const TABS = [
  { label: "planner", seed: "dk-6", role: "planner", asks: true },
  { label: "7c2e", seed: "dk-50", role: "worker" },
];
const DECKS: Array<{ name: string; status: string; heads: ReturnType<typeof H>[]; cloud: boolean; asks?: boolean }> = [
  { name: "Migrate matchkey", status: "5 working", heads: MATCHKEY, cloud: true },
  { name: "addriva", status: "Pull request open", heads: [H("dk-0", "planner"), H("dk-28", "worker"), H("dk-41", "worker")], cloud: true },
];

export function Tiles() {
  return (
    <section className="dt-tiles" aria-label="Built for swarms">
      <article className="dt-tile dt-tile--col" data-reveal>
        <div className="dt-tile__words">
          <h2>Every agent, its own column.</h2>
          <p>Its whole thread, live. When it needs you, the question docks at its foot.</p>
        </div>
        <div className="dt-tile__pic" data-ui aria-hidden="true">
          <section className="dk-col dk-col--solo is-asks">
            <ColumnHead a={PLANNER} onClose />
            <Thread lines={PLANNER.thread.slice(2)} />
            <Decision title={ASK.title} sub={ASK.sub} tabIndex={-1} />
          </section>
        </div>
      </article>

      <article className="dt-tile dt-tile--keys" data-reveal style={delay(80)}>
        <div className="dt-tile__words">
          <h2>Every move, a key.</h2>
          <p>Projects, agents and answers, all from the keyboard. Moves never wait on an animation.</p>
        </div>
        <ul className="dt-keys">
          {KEYCAPS.map((k) => (
            <li key={k.what}><span className="dt-keys__caps">{k.keys.map((c) => <kbd key={c}>{c}</kbd>)}</span><span>{k.what}</span></li>
          ))}
        </ul>
      </article>

      <article className="dt-tile dt-tile--bar" data-reveal>
        <div className="dt-tile__words">
          <h2>Every project, one title bar.</h2>
          <p>One project open, the rest folded into decks. When one needs you, its deck says so.</p>
        </div>
        <div className="dt-tile__pic dt-tile__pic--bar" data-ui aria-hidden="true">
          <div className="dk-tb">
            <div className="dk-bar dk-bar--solo">
              <span className="dk-lights"><i /><i /><i /></span>
              <div className="dk-open">
                <span className="dk-open__name"><Icon name="laptop" size={17} /><span><b>Fix proration</b><small>Local · 0:52</small></span></span>
                <div className="dk-tabs">
                  {TABS.map((t, k) => (
                    <span key={t.label} className={`dk-tab${k === 0 ? " is-asks" : " is-on is-first is-last"}`}>
                      <Bot seed={t.seed} role={t.role} /><span>{t.label}{t.asks ? <em> asks</em> : null}</span>
                    </span>
                  ))}
                </div>
              </div>
              {DECKS.map((d) => (
                <span key={d.name} className="dk-deck">
                  <Icon name={d.cloud ? "cloud" : "laptop"} size={16} />
                  <span><b>{d.name}</b><small>{d.status}</small></span>
                  <span className="dk-heads">{d.heads.map((h) => <Bot key={h.seed} seed={h.seed} role={h.role} />)}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}
