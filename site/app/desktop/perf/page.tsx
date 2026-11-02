import type { Metadata } from "next";
import "../desktop.css";
import "./perf.css";
import { Flame, FlameKey } from "@/components/desktop/Flames";
import { AbRanges, Bursts, Hitches, SlideLanes } from "@/components/desktop/PerfCharts";
import { PerfStrips } from "@/components/desktop/PerfStrips";
import { Footer } from "@/components/Footer";
import { delay } from "@/components/marks";
import { Nav } from "@/components/Nav";
import { Reveals } from "@/components/Reveals";
import { AB_RUNS, BENCH_HELP, CALLOUTS, FLAMES, HITCH_LISTS, HYPOTHESES, LEADS, PIPELINE, PROBES, READOUTS, SIZE_FIX, SIZE_PROFILE, SLIDE, STRETCH_PROBE, UNTRUSTED } from "@/lib/perf";
import { SITE } from "@/lib/site";

// "Benching the Reel", the perf log an agent wrote on 30 Oct 2026 while it tuned the desktop app's reel, rebuilt as a
// page of the site. Its numbers and terminals are lib/perf.ts; its charts are drawn from lib/perf-log.json,
// lib/perf-reel.json and public/desktop/perf-trees.json.
const title = "Every millisecond on the main thread · capcomd Desktop";
const description = "How an agent made the capcomd Desktop reel smooth with DeskBench and xctrace: main-thread CPU from 10.1 s to 3.6 s, frame time from 68 ms to 12.6, and what is still over budget.";

export const metadata: Metadata = {
  title, description,
  alternates: { canonical: "/desktop/perf/" },
  openGraph: { type: "article", siteName: SITE.name, title: "Every millisecond on the main thread", description, url: "/desktop/perf/", images: [{ url: "/og.png", width: 1200, height: 630, alt: "capcomd's crew of pixel bots." }] },
  twitter: { card: "summary_large_image", title: "Every millisecond on the main thread", description, images: ["/og.png"] },
};

const Term = ({ title, children }: { title: string; children: string }) => (
  <figure className="pf-term">
    <figcaption>{title}</figcaption>
    <pre><code>{children}</code></pre>
  </figure>
);

const SHOTS: Array<[number, string]> = [[0, "the planner in focus"], [5, "five steps along, worker 1edc in focus"], [10, "ten steps along, worker 2db8 in focus"]];

export default function PerfPage() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="pf-hero">
        <Nav home={false} current="desktop" />
        <div className="pf-hero__words">
          <h1 className="dk-h1 pf-h1" data-load style={delay(60)}>Every millisecond on the main thread.</h1>
          <div className="pf-hero__side" data-load style={delay(160)}>
            <p className="pf-hero__lead">An agent made the capcomd Desktop reel smooth by reading what macOS itself records: the main thread sampled every millisecond, the compositor&apos;s list of late frames, every wake-up of the run loop. This is what it saw, before and after.</p>
            <p className="pf-hero__meta">Perf log of 30 October 2026. CapcomdDeskBench, release build, on a MacBook Pro with a 120 Hz panel. <a href="/desktop/">Back to capcomd Desktop</a></p>
          </div>
        </div>
        <div className="pf-pad" data-load style={delay(240)}><PerfStrips /></div>
        <dl className="dk-readouts pf-pad">
          {READOUTS.map(([was, now, unit, what], k) => (
            <div key={what} data-reveal style={delay(60 * k)}>
              <dt><span className="dk-was">{was}</span><span className="dk-arr" aria-label="became"> → </span>{now}<small>{unit}</small></dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="pf-sec pf-bench" id="bench" aria-labelledby="bench-h">
          <h2 id="bench-h" className="dk-h2" data-reveal>A profiler an agent can drive.</h2>
          <div className="pf-bench__words" data-reveal style={delay(80)}>
            <p>Instruments is built for a person at a mouse. An agent can&apos;t drag across a track or expand a call tree. It can run a command, read JSON and compare two numbers. DeskBench gives it the parts of Instruments that matter for a scrolling window, in that shape.</p>
            <p>It hosts the app&apos;s real views, the same code the app runs, loads a fixed crew of 17 agents instead of a live daemon, drives a named scenario and judges the result against the budget in the design spec. Every command takes <code>--json</code>. Every outcome has an exit code.</p>
          </div>
          <div className="pf-bench__term" data-reveal style={delay(140)}><Term title="deskbench help">{BENCH_HELP}</Term></div>
          <figure className="pf-film">
            <ul>
              {SHOTS.map(([n, what], k) => (
                <li key={n} data-reveal style={delay(80 * k)}>
                  <img src={`/desktop/bench-at${n}.jpg`} width={1920} height={1184} alt={`The capcomd Desktop window on the bench's 17-agent fixture, ${what}.`} loading="lazy" decoding="async" />
                  <span><code>--at {n}</code> {what}</span>
                </li>
              ))}
            </ul>
            <figcaption>The window the <code>step</code> scenario walks, from <code>deskbench snapshot --fixture crew17</code>. The text in the columns is generated test data.</figcaption>
          </figure>
        </section>

        <section className="pf-sec pf-probes" id="probes" aria-labelledby="probes-h">
          <div className="pf-head">
            <h2 id="probes-h" className="dk-h2" data-reveal>Five probes inside the window.</h2>
            <p data-reveal style={delay(80)}>xctrace sees everything, but it costs a recording and an export. Most questions are cheaper. The bench answers them from inside the process, on every run, with probes that cost microseconds.</p>
          </div>
          <ol className="pf-probes__list">
            {PROBES.map(([api, setup, what, fields], k) => (
              <li key={api} data-reveal style={delay(50 * k)}>
                <h3><code>{api}</code><span>{setup}</span></h3>
                <p>{what}</p>
                <p className="pf-probes__f"><code>{fields}</code></p>
              </li>
            ))}
          </ol>
          <div className="pf-pair">
            <Term title="Harness.swift · the stretch probe">{STRETCH_PROBE}</Term>
            <Term title="deskbench profile step --template time · before">{UNTRUSTED}</Term>
          </div>
          <p className="pf-note"><b>The bench says when not to believe it.</b> Before every run it measures one idle second and lists busy processes. Here xctrace&apos;s own helper used 172% of a core, so the run is marked untrusted (exit 5): a failed budget means &ldquo;run it again&rdquo;, not &ldquo;the reel is slow&rdquo;. On a Mac its owner was using at the same time, this verdict kept the agent from chasing noise.</p>
        </section>

        <section className="pf-sec pf-xc" id="xctrace" aria-labelledby="xc-h">
          <div className="pf-head pf-head--stack">
            <h2 id="xc-h" className="dk-h2" data-reveal>xctrace, attached and parsed.</h2>
            <p data-reveal style={delay(80)}><code>deskbench profile</code> starts a child copy of itself that opens the window and waits. The parent attaches xctrace to the child, the scenario runs under the recorder, and the tables come back out through <code>xctrace export</code>. The agent gets one JSON document: where the main thread&apos;s samples went, the bursts of 16 ms or more and what ran inside them, the compositor&apos;s hitches and their causes, and the hangs.</p>
          </div>
          <ol className="pf-pipe">
            {PIPELINE.map(([what, detail], k) => <li key={what} data-reveal style={delay(60 * k)}><b>{what}</b><span>{detail}</span></li>)}
          </ol>
          <p className="pf-note">Every chart on this page comes from those exports: 10,088, 9,451 and 3,631 main-thread samples of the <code>step</code> scenario on three builds, two recordings of project switches, and two lists of hitches.</p>
        </section>

        <section className="pf-sec" id="flames" aria-labelledby="fl-h">
          <div className="pf-head">
            <h2 id="fl-h" className="dk-h2" data-reveal>Three flame graphs, one scale.</h2>
            <p data-reveal style={delay(80)}>Every sample is one millisecond of the main thread on a CPU, and all three graphs use the same pixels per sample. So a graph&apos;s width is what the same eight steps cost on that build, and the colour says which part of the system spent it. Hover a bar to read it, click to zoom in.</p>
          </div>
          <FlameKey />
          <div className="pf-flames">
            {FLAMES.map((f) => <Flame key={f.key} tree={f.key} scaleTo="before" title={f.title} sub={f.sub} />)}
          </div>
          <dl className="pf-calls">
            {CALLOUTS.map(([build, what, ms, story], k) => (
              <div key={what} data-reveal style={delay(60 * k)}>
                <dt><b>{ms}<small>ms</small></b><span>{build}, {what}</span></dt>
                <dd>{story}</dd>
              </div>
            ))}
          </dl>
          <div className="pf-pair">
            <Term title="deskbench profile step --template time · middle build">{SIZE_PROFILE}</Term>
            <Term title="The fix, in Reel.swift">{SIZE_FIX}</Term>
          </div>
        </section>

        <section className="pf-sec pf-slide" id="slide" aria-labelledby="sl-h">
          <h2 id="sl-h" className="dk-h2" data-reveal>The slide left the main thread.</h2>
          <div className="pf-slide__words" data-reveal style={delay(80)}>
            <p>An AppKit scroll animation runs on the main thread. Every tick sets the clip view&apos;s origin, every origin change is a bounds change, and every bounds change reaches each column&apos;s SwiftUI graph. With sixteen columns that cost about 20 ms a frame, more than two frames at 120 Hz.</p>
            <p>Now the offset moves to its destination once, so the columns update a single time, and the motion goes to the render server as one additive animation. The render server draws every frame itself. The main thread is free while the reel moves.</p>
          </div>
          <div className="pf-slide__fig" data-reveal><SlideLanes /><p className="pf-key"><i className="pf-key--busy" />main thread at work <i className="pf-key--frame" />a frame reaches the panel</p></div>
          <Term title="The slide, in Reel.swift">{SLIDE}</Term>
          <p className="pf-note pf-slide__note">Drawn from the bench&apos;s medians. Before, the display link ticked every 41.7 ms on the 17-agent crew: the panel fell back to 24 Hz because the main thread couldn&apos;t keep up. After, frames arrive at the panel&apos;s top rate, every 8.3 ms. The curve (0.23, 1, 0.32, 1) is a strong ease-out: the reel answers the click at once and settles softly.</p>
        </section>

        <section className="pf-sec" id="hitches" aria-labelledby="hi-h">
          <div className="pf-head">
            <h2 id="hi-h" className="dk-h2" data-reveal>What the compositor saw.</h2>
            <p data-reveal style={delay(80)}>The bench&apos;s display link measures what the main thread could have drawn. The Animation Hitches instrument records what the window server actually showed late. Each spike is one frame that reached the glass after its deadline, as tall as it was late. Same scenario, same 12 seconds, same scale.</p>
          </div>
          <div data-reveal><Hitches /></div>
          <div className="pf-pair">
            {HITCH_LISTS.map(([name, list]) => <Term key={name} title={`deskbench profile step --template hitches · ${name.toLowerCase()}`}>{list}</Term>)}
          </div>
          <p className="pf-note">After, every hitch is exactly one, two or three 120 Hz frames late: 8.3, 16.7 or 25 ms. Before, they add up to 8.2 seconds of lateness inside a 12-second recording.</p>
        </section>

        <section className="pf-sec pf-bursts" id="bursts" aria-labelledby="bu-h">
          <div className="pf-head pf-head--stack">
            <h2 id="bu-h" className="dk-h2" data-reveal>Where the time went.</h2>
            <p data-reveal style={delay(80)}>A burst is a stretch the main thread spent without going back to the run loop. Anything longer than a frame is a frame you didn&apos;t get. Each bar weighs a burst length by the milliseconds spent in it, so it shows where the cost sat, not how often the thread woke.</p>
          </div>
          <div data-reveal><Bursts /></div>
        </section>

        <section className="pf-sec" id="ab" aria-labelledby="ab-h">
          <div className="pf-head">
            <h2 id="ab-h" className="dk-h2" data-reveal>Proved by alternating runs.</h2>
            <p data-reveal style={delay(80)}>On a shared Mac, one run proves nothing: the same build measured 26 and 709 hitches in two runs an hour apart. <code>deskbench ab</code> runs two builds in turn, one fresh process per run, and compares medians against a noise band set per metric from the spread of the runs. The verdict is one word and an exit code.</p>
          </div>
          <div data-reveal><AbRanges /></div>
          <div className="pf-pair">
            {AB_RUNS.map(([cmd, out]) => <Term key={cmd} title={cmd}>{out}</Term>)}
          </div>
          <p className="pf-note"><b>Late frames is the odd one out.</b> The old build presents so few frames, with the panel down at 24 Hz, that few can be counted late; the new one runs the panel at up to 120 Hz. An earlier run of this comparison exited 4, a regression. The agent read the per-step JSON, saw the display rate change, and judged on frame time and stretches instead.</p>
        </section>

        <section className="pf-sec pf-loop" id="loop" aria-labelledby="lo-h">
          <div className="pf-head">
            <h2 id="lo-h" className="dk-h2" data-reveal>Seven ideas. Four kept.</h2>
            <p data-reveal style={delay(80)}>Every idea went through the same loop: state it, change the code, build a numbered copy of the bench, run it against the last good copy, and profile when the numbers didn&apos;t explain themselves. Every build stayed runnable, which is how both wrong turns were caught.</p>
          </div>
          <ol className="pf-hyp">
            {HYPOTHESES.map(([id, kept, claim, evidence, verdict, outcome], k) => (
              <li key={id} className={kept ? "is-kept" : undefined} data-reveal style={delay(40 * k)}>
                <span className="pf-hyp__id">{id}</span>
                <div><p className="pf-hyp__c">{claim}</p><p>{evidence}</p></div>
                <p className="pf-hyp__v"><b>{verdict}</b>{outcome}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="pf-sec pf-still" id="still" aria-labelledby="st-h">
          <div className="pf-head">
            <h2 id="st-h" className="dk-h2" data-reveal>Still slow: the switch.</h2>
            <p data-reveal style={delay(80)}>Switching projects is 3.2 times faster to the first frame, and still over budget: 170 ms against 50. The frames right after a switch are heavy too, with runs of 400 ms on both builds. The profile of six switches names what comes next.</p>
          </div>
          <div data-reveal><PerfStrips scenario="switch" /></div>
          <Flame tree="switch" title="After, six project switches" sub="9bcd41a · 7,267 samples · its own scale" />
          <ul className="pf-leads">
            {LEADS.map(([ms, where, symbol, what], k) => (
              <li key={symbol} data-reveal style={delay(50 * k)}>
                <b>{ms}<small>ms, {where}</small></b>
                <div><h3><code>{symbol}</code></h3><p>{what}</p></div>
              </li>
            ))}
            <li data-reveal style={delay(250)}><b className="pf-leads__none">Not measured yet</b><div><h3>A real trackpad</h3><p>The bench sends synthetic scroll phases. How a swipe feels under a finger still needs a person.</p></div></li>
          </ul>
        </section>

        <section className="pf-coda" aria-labelledby="coda-h">
          <h2 id="coda-h" className="dk-h2">Sources.</h2>
          <div>
            <p>Every chart is drawn from files the bench wrote on 30 October 2026: <code>deskbench profile</code> of the step and switch scenarios with the time and hitches templates, on the original build (3a6b5b7), the first AppKit reel and the final build (9bcd41a), exported with <code>xctrace export</code>; and <code>deskbench ab</code> with five runs a side for step, switch and fling. Profiled runs carry the profiler&apos;s own overhead and the bench marked them untrusted, so they show where the time went; the A/B runs show how much.</p>
            <p>Machine: MacBook Pro (MacBookPro18,3), 8 cores, 16 GB, macOS 27.0.1, 120 Hz ProMotion panel, in use by its owner during the runs. capcomd Desktop is in development and not yet released.</p>
            <p className="pf-coda__act"><a className="button" href="/desktop/">capcomd Desktop</a><a href={SITE.repo}>Watch on GitHub</a></p>
          </div>
        </section>
      </main>
      <Footer />
      <Reveals />
    </>
  );
}
