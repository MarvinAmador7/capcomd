import type { Metadata } from "next";
import "./perfloop.css";
import { Footer } from "@/components/Footer";
import { delay } from "@/components/marks";
import { Nav } from "@/components/Nav";
import { Night } from "@/components/perfloop/Night";
import { Reveals } from "@/components/Reveals";
import { CAPABILITIES, LOOP_CMDS, SPLIT, SPLIT_TOTAL, SWEEP } from "@/lib/perfloop";
import { SITE } from "@/lib/site";

// PerfLoop, the harness that gives coding agents senses for a native Mac app (tools/perfloop on main). The story and
// every number are design/perf-loop/JOURNEY.md and apps/menubar/app/LAYOUT.md; JOURNEY §7's "what not to claim" holds.
const title = "PerfLoop · agents that see, feel and improve";
const description = "PerfLoop gives coding agents the senses a native Mac app needs: where every millisecond goes, how a swipe feels, and a loop that keeps only what's better, run every night.";
const CODE = "https://github.com/MarvinAmador7/perfloop";

export const metadata: Metadata = {
  title, description,
  alternates: { canonical: "/perfloop/" },
  openGraph: { type: "website", siteName: SITE.name, title: "Agents that see, feel and improve", description, url: "/perfloop/", images: [{ url: "/og.png", width: 1200, height: 630, alt: "capcomd's crew of pixel bots." }] },
  twitter: { card: "summary_large_image", title: "Agents that see, feel and improve", description, images: ["/og.png"] },
};

/** A window of the reel, drawn small: columns of thread lines, or blank columns where a cheat skipped the work. */
function Reel({ blank = false, ghost = false }: { blank?: boolean; ghost?: boolean }) {
  return (
    <span className={`pl-reel${blank ? " is-blank" : ""}${ghost ? " is-ghost" : ""}`} aria-hidden="true">
      <span className="pl-reel__bar"><i /><i /><i /></span>
      <span className="pl-reel__cols">
        {[7, 5, 8, 6, 7].map((n, c) => (
          <span key={c} className="pl-reel__col">{Array.from({ length: n }, (_, k) => <i key={k} style={{ width: `${55 + ((c * 7 + k * 13) % 40)}%` }} />)}</span>
        ))}
      </span>
    </span>
  );
}

/** The swipe finding as a diagram: the fingers lift, AppKit's deceleration carries the reel ~200 pt past the column
 *  edge, and nothing snaps it back. Only the 200 pt is measured; the curves are drawn. */
function Swipe() {
  const y = (pt: number) => 230 - pt * 0.3;
  const fingers = "M40 230 C 90 222, 150 160, 210 " + y(300);
  const content = `M40 230 C 90 222, 150 160, 210 ${y(300)} C 270 ${y(470)}, 360 ${y(625)}, 560 ${y(637)}`;
  const meant = `M210 ${y(300)} C 250 ${y(400)}, 300 ${y(437)}, 560 ${y(437)}`;
  return (
    <svg className="pl-swipe" viewBox="0 0 600 260" role="img" aria-label="After the fingers lift, the reel keeps coasting about 200 points past the column edge and stays there instead of settling on the edge.">
      <line className="pl-swipe__edge" x1="30" x2="580" y1={y(437)} y2={y(437)} />
      <text className="pl-swipe__t" x="578" y={y(437) + 18} textAnchor="end">column edge</text>
      <path className="pl-swipe__meant" d={meant} />
      <path className="pl-swipe__content" d={content} />
      <path className="pl-swipe__fingers" d={fingers} />
      <circle className="pl-swipe__lift" cx="210" cy={y(300)} r="6" />
      <text className="pl-swipe__t" x="222" y={y(300) + 22}>fingers lift</text>
      <path className="pl-swipe__gap" d={`M548 ${y(437)} V ${y(637)}`} />
      <text className="pl-swipe__t pl-swipe__t--hot" x="540" y={y(545) + 5} textAnchor="end">≈200 pt past</text>
    </svg>
  );
}

const MAX = SPLIT_TOTAL.at40;

export default function PerfLoopPage() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="pl-hero">
        <Nav home={false} />
        <div className="pl-hero__words">
          <p className="pl-eyebrow" data-load style={delay(20)}>PerfLoop</p>
          <h1 className="pl-h1" data-load style={delay(60)}><span>Agents that see,</span> <span>feel and improve.</span></h1>
          <p className="pl-sub" data-load style={delay(140)}>PerfLoop gives coding agents the senses a native Mac app needs: where every millisecond goes, how a swipe feels, and a loop that keeps only what&apos;s better. Then it lets them run it every night.</p>
          <p className="pl-act" data-load style={delay(220)}>
            <a className="button" href={CODE}>Read the code</a>
            <span>Open source, MIT. Made on <a href="/desktop/">capcomd Desktop</a>; works with any AppKit or SwiftUI app.</span>
          </p>
        </div>
        <div className="pl-hero__night" data-load style={delay(320)}><Night /></div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="pl-sec pl-see" aria-labelledby="see-h">
          <div className="pl-words">
            <p className="pl-num" data-reveal>Sees</p>
            <h2 id="see-h" className="pl-h2" data-reveal>It sees why.</h2>
            <p className="pl-lead" data-reveal style={delay(60)}>An agent can&apos;t squint at a flame graph. PerfLoop samples the main thread inside every long stretch and traces each re-render to the state change behind it. Ask why it&apos;s slow; get an answer in words.</p>
          </div>
          <figure className="pl-fig pl-two" data-reveal style={delay(120)}>
            <div className="pl-two__pic">
              <Reel ghost />
              <Reel />
              <span className="pl-two__tag pl-two__tag--back">the app&apos;s window</span>
              <span className="pl-two__tag">the bench&apos;s second window</span>
            </div>
            <dl className="pl-read">
              <dt><span className="pl-was">180</span><span aria-label="became"> → </span>120<small>ms</small></dt>
              <dd>main-thread CPU for a 17-agent step, once the loop caught its own bench measuring two windows.</dd>
            </dl>
            <figcaption>The cause records said every column ran twice per update. That made no sense, so an agent chased it until the instrument was the answer: the bench had opened a second window in front of the app&apos;s. Every number recorded before the fix was about twice the real cost.</figcaption>
          </figure>
        </section>

        <section className="pl-sec pl-feel" aria-labelledby="feel-h">
          <div className="pl-words">
            <p className="pl-num" data-reveal>Feels</p>
            <h2 id="feel-h" className="pl-h2" data-reveal>It feels the swipe.</h2>
            <p className="pl-lead" data-reveal style={delay(60)}>Smooth becomes a number an agent can climb. A swipe is replayed into the real window with its timing, and scored on how closely the content followed the fingers.</p>
          </div>
          <figure className="pl-fig" data-reveal style={delay(120)}>
            <Swipe />
            <p className="pl-key"><span><i className="pl-key--fingers" />fingers</span><span><i className="pl-key--content" />the reel</span><span><i className="pl-key--meant" />where it should settle</span></p>
            <figcaption>The first swipe replayed with real timestamps found a bug: AppKit&apos;s deceleration carried the reel up to about 200 pt past the column edge, and nothing snapped it back. The old synthetic fling sent no timestamps, which hid the bug and its cost.</figcaption>
          </figure>
          <dl className="pl-figs">
            <div data-reveal><dt>48<small>/48</small></dt><dd>replays of three synthetic gestures with the content on the fingers&apos; path: 0 pt off at p95, against a bar of 1.</dd></div>
            <div data-reveal style={delay(60)}><dt>2×</dt><dd>the main-thread CPU of a swipe with real timing, against the synthetic one it replaced.</dd></div>
          </dl>
        </section>

        <section className="pl-sec pl-check" aria-labelledby="check-h">
          <div className="pl-words">
            <p className="pl-num" data-reveal>Improves</p>
            <h2 id="check-h" className="pl-h2" data-reveal>Only better survives.</h2>
            <p className="pl-lead" data-reveal style={delay(60)}>So you can leave it alone. A change is kept only if it wins outside the noise and passes guards the agent can&apos;t edit: every column built, every pixel where it was.</p>
          </div>
          <figure className="pl-fig pl-cheat" data-reveal style={delay(120)}>
            <div className="pl-cheat__pair">
              <div><Reel /><p><b>Today&apos;s build</b><span>114 ms to switch projects</span></p></div>
              <div><Reel blank /><p><b>A build that cheats</b><span>67 ms: 41 % faster, on paper</span></p></div>
            </div>
            <ul className="pl-guards">
              <li><code>built-within</code><span>failed, rep 1</span></li>
              <li><code>built-within</code><span>failed, rep 2</span></li>
              <li><code>snapshot-diff</code><span>1.9 %, over the 0.5 % limit</span></li>
              <li className="pl-guards__v">rejected</li>
            </ul>
            <figcaption>We planted the cheat to test the guards. Two honest builds differ by 0.13 %. Later the guards caught a real one: a layout experiment that looked 27 % faster because its columns were blank.</figcaption>
          </figure>
          <ul className="pl-rules">
            <li data-reveal><h3>Noise can&apos;t fool it.</h3><p>The same build measured against itself lands inside its noise bands. A run on a busy Mac is marked untrusted and decides nothing.</p></li>
            <li data-reveal style={delay(60)}><h3>It can&apos;t fool itself.</h3><p>The guards and their limits come from the build it&apos;s trying to beat. Only you can loosen one, and never from inside an experiment.</p></li>
            <li data-reveal style={delay(120)}><h3>Behaviour is yours.</h3><p>A change that alters what the app does waits for your approval. Bugs it finds come to you; it doesn&apos;t quietly fix them.</p></li>
          </ul>
        </section>

        <section className="pl-sec pl-night2" aria-labelledby="sleep-h">
          <div className="pl-words">
            <p className="pl-num" data-reveal>Again</p>
            <h2 id="sleep-h" className="pl-h2" data-reveal>Every night, from where it stopped.</h2>
            <p className="pl-lead" data-reveal style={delay(60)}>PerfLoop runs while nobody needs the Mac and writes every result to a ledger the next agent reads first. That&apos;s how improvement compounds.</p>
          </div>
          <ol className="pl-steps">
            <li data-reveal><h3>Waits for a quiet Mac.</h3><p>It starts once nobody has touched the Mac for two minutes, redoes a run if you touch it, and won&apos;t start at all on a locked screen.</p></li>
            <li data-reveal style={delay(60)}><h3>Or borrows a spare one.</h3><p>It copies the build to another Mac over SSH, opens the window there and brings the numbers back. Results from different machines never mix.</p></li>
            <li data-reveal style={delay(120)}><h3>And remembers.</h3><p>The append-only ledger is the loop&apos;s memory across sessions. Each experiment leaves one file that&apos;s enough to decide the next step, so the next agent picks up where the last one stopped.</p></li>
          </ol>
          <p className="win pl-cmd" data-reveal><code>perfloop queue run --runner ssh://mini --until 07:00</code></p>
        </section>

        <section className="pl-sec pl-decide" aria-labelledby="decide-h">
          <div className="pl-words">
            <p className="pl-num" data-reveal>Decides</p>
            <h2 id="decide-h" className="pl-h2" data-reveal>It told us what not to build.</h2>
            <p className="pl-lead" data-reveal style={delay(60)}>We were tempted to write our own rendering engine. The loop showed why the window slows as agents are added: AppKit and SwiftUI walking and re-placing views. Layout maths never showed up, so a faster layout engine would solve a problem we don&apos;t have.</p>
          </div>
          <figure className="pl-fig pl-split" data-reveal style={delay(120)}>
            {(["at4", "at40"] as const).map((n) => {
              const other = (n === "at4" ? SPLIT_TOTAL.at4 : SPLIT_TOTAL.at40) - SPLIT.reduce((s, r) => s + r[n], 0);
              return (
                <div key={n} className="pl-split__row">
                  <p><b>{n === "at4" ? "4 agents" : "40 agents"}</b><span>{SPLIT_TOTAL[n]} ms a step</span></p>
                  <span className="pl-split__bar" aria-hidden="true">
                    {SPLIT.map((r, k) => r[n] > 0 ? <i key={r.what} className={`pl-c${k}`} style={{ width: `${(r[n] / MAX) * 100}%` }} /> : null)}
                    <i className="pl-c-rest" style={{ width: `${(other / MAX) * 100}%` }} />
                  </span>
                </div>
              );
            })}
            <ul className="pl-split__key">
              {SPLIT.map((r, k) => <li key={r.what}><i className={`pl-c${k}`} />{r.what}<span>{r.at4 || "–"} → {r.at40} ms</span></li>)}
              <li><i className="pl-c-rest" />Everything else</li>
            </ul>
            <figcaption>Main-thread time of one step, split by what spent it, at 4 and 40 agents. The cost grows with the views SwiftUI makes for the threads, about 1,100 of them, not with how hard layout is.</figcaption>
          </figure>
          <dl className="pl-figs pl-figs--3">
            {SWEEP.map((s, k) => (
              <div key={s.what} data-reveal style={delay(60 * k)}><dt>{s.perAgent.toFixed(2)}<small>ms</small></dt><dd>per added agent: {s.what} ({s.from} → {s.to} ms from 4 to 64 agents).</dd></div>
            ))}
          </dl>
          <p className="pl-after" data-reveal>Next: thread rows drawn natively with Core Text. The engine question stays open, and now it has a test.</p>
        </section>

        <section className="pl-sec pl-built" aria-labelledby="built-h">
          <h2 id="built-h" className="pl-h2" data-reveal>Agents built it, too.</h2>
          <p className="pl-lead" data-reveal style={delay(60)}>The plan gave PerfLoop&apos;s first five phases seven to eight weeks. Coding agents built them in a day and a half, in parallel worktrees, merging each phase only once its tests and its checks on the real window passed.</p>
          <dl className="pl-figs pl-figs--3">
            <div data-reveal><dt>1½<small>days</small></dt><dd>for phases planned at seven to eight weeks.</dd></div>
            <div data-reveal style={delay(60)}><dt>~65</dt><dd>commits, merged phase by phase.</dd></div>
            <div data-reveal style={delay(120)}><dt>120</dt><dd>tests in about 8,000 lines, plus 77 for the app&apos;s adapter.</dd></div>
          </dl>
        </section>

        <section className="pl-sec pl-eng" aria-labelledby="eng-h">
          <details>
            <summary id="eng-h">For engineers: the ten capabilities, the loop and what&apos;s not done</summary>
            <ol className="pl-caps">
              {CAPABILITIES.map(([id, name, what]) => <li key={id}><span>{id}</span><h3>{name}</h3><p>{what}</p></li>)}
            </ol>
            <dl className="pl-cmds">
              {LOOP_CMDS.map(([cmd, what]) => <div key={cmd}><dt><code>{cmd}</code></dt><dd>{what}</dd></div>)}
            </dl>
            <h3 className="pl-eng__h">Not done yet</h3>
            <ul className="pl-eng__not">
              <li>Feel is scored on synthetic gestures; a swipe recorded by hand is next.</li>
              <li>Trusted numbers from the spare Mac wait on an unlocked screen. Runs on the developer&apos;s own Mac are marked untrusted.</li>
              <li>On capcomd Desktop, no experiment has beaten today&apos;s build yet, so the loop has no speed-up there to claim. The reel&apos;s earlier gains were made by hand, in the <a href="/desktop/perf/">perf log</a>.</li>
              <li>The VM runner is a stub.</li>
            </ul>
          </details>
        </section>

        <section className="pl-sec pl-close" aria-labelledby="close-h">
          <h2 id="close-h" className="pl-h2" data-reveal>Bring it to your app.</h2>
          <p className="pl-sub" data-reveal style={delay(60)}>PerfLoop has its own repository, MIT-licensed. Add it to an AppKit or SwiftUI app, or start with the sample app that comes with it.</p>
          <p className="pl-act" data-reveal style={delay(120)}>
            <a className="button" href={CODE}>Read the code</a>
            <a href="/desktop/perf/">Read the perf log</a>
          </p>
        </section>
      </main>
      <Footer />
      <Reveals />
    </>
  );
}
