import type { Metadata } from "next";
import "./desktop.css";
import { ColumnLab } from "@/components/desktop/ColumnLab";
import { Decks } from "@/components/desktop/Decks";
import { HeroReel } from "@/components/desktop/HeroReel";
import { Keys } from "@/components/desktop/Keys";
import { PerfStrips } from "@/components/desktop/PerfStrips";
import { StartLumen } from "@/components/desktop/StartLumen";
import { Footer } from "@/components/Footer";
import { delay } from "@/components/marks";
import { Nav } from "@/components/Nav";
import { Reveals } from "@/components/Reveals";
import { FIXES, READOUTS } from "@/lib/perf";
import { SITE } from "@/lib/site";

const title = "capcomd Desktop · every agent, one native window";
const description = "capcomd Desktop is a native Mac app, written entirely in Swift, that shows each coding agent in a run as its own column and calls on you only when one of them needs a decision. In development.";

export const metadata: Metadata = {
  title, description,
  alternates: { canonical: "/desktop/" },
  openGraph: { type: "website", siteName: SITE.name, title: "capcomd Desktop", description, url: "/desktop/", images: [{ url: "/og.png", width: 1200, height: 630, alt: "capcomd's crew of pixel bots." }] },
  twitter: { card: "summary_large_image", title: "capcomd Desktop", description, images: ["/og.png"] },
};

// SPEC.md §1 (apps/menubar/design/desktop): the budgets every change to the window is held to.
const BUDGETS: Array<[string, string, string, string]> = [
  ["100", "", "ms", "from launch to the window's first frame. Nothing is fetched first: columns fill as the data arrives."],
  ["50", "", "ms", "to switch projects, with ⌘1–9 or a click on a deck."],
  ["8", ".3", "ms", "a frame while the reel scrolls 17 agents: 120 Hz, nothing dropped."],
  ["1", "", "stream", "per open run, however many columns it has."],
];

// The app, top to bottom (apps/menubar/app on feat/desktop-shell): [framework, what it draws, how, the real code].
const LAYERS: Array<[string, string, string, string]> = [
  ["SwiftUI", "Every column", "Threads, diffs, logs and bots are SwiftUI views, the same code the menu bar app draws with.", "Column(agentId: id)"],
  ["AppKit", "The reel", "An NSScrollView with one hosting view per column. A scroll moves one view, not seventeen graphs.", "class SnapScrollView: NSScrollView"],
  ["Core Animation", "Every slide", "One animation the render server draws by itself at the panel's full 120 Hz, while the main thread sleeps.", "CABasicAnimation(keyPath: \"position.x\")"],
  ["San Francisco", "Every letter", "SF Pro and SF Mono, the system's own faces, set by Core Text at the sizes macOS uses.", "Font.system(size: 13)"],
  ["The menu bar", "Every shortcut", "⌘1–9, ⌃1–9 and ⌃← → sit in a real Go menu, where a Mac user looks for them.", "CommandMenu(\"Go\")"],
  ["A Unix socket", "Every update", "One event stream per open run from the capcomd daemon on your Mac. No port, no browser.", "GET /v1/streams/{scope}/events"],
];
const NATIVE_FACTS: Array<[string, string]> = [["0", "web views"], ["100%", "Swift"], ["120 Hz", "slides on ProMotion"]];

const CREDITS = (
  <>
    Photographs: <a href="https://commons.wikimedia.org/wiki/File:Overall_view_of_Mission_Control_on_first_day_of_Apollo_7_space_mission_(S68-49301).jpg">Mission Control on the first day of Apollo 7</a> and{" "}
    <a href="https://commons.wikimedia.org/wiki/File:Activity_in_the_Mission_Control_Center_during_Apollo_14_(S71-17610).jpg">Mission Control during Apollo 14</a>, NASA Johnson Space Center, public domain;{" "}
    <a href="https://commons.wikimedia.org/wiki/File:Apollo_Mission_Control_Consoles_(2342101272).jpg">Apollo Mission Control Consoles</a> by Mike Renlund, <a href="https://creativecommons.org/licenses/by/2.0">CC BY 2.0</a>. All via Wikimedia Commons.
  </>
);

export default function DesktopPage() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="dk-hero">
        <Nav home={false} current="desktop" />
        <div className="dk-hero__words">
          <h1 className="dk-h1" data-load style={delay(60)}>Every agent. One native window.</h1>
          <p className="dk-hero__lead" data-load style={delay(160)}>A Mac app written entirely in Swift. No web view, no Electron. Each coding agent in your run gets its own column, and you hear from them only when one needs a decision.</p>
          <p className="dk-hero__act" data-load style={delay(240)}>
            <a className="button" href={SITE.repo}>Watch on GitHub</a>
            <span>In development for macOS. The CLI works today: <a href="/#install">install it</a>.</span>
          </p>
        </div>
        <div className="dk-stage">
          <div className="dk-stage__in"><HeroReel /></div>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="dk-native" id="native" aria-labelledby="native-h">
          <div className="dk-native__head">
            <h2 id="native-h" className="dk-h2" data-reveal>Native, all the way down.</h2>
            <p className="dk-lead" data-reveal style={delay(80)}>No web view, no bundled browser, no JavaScript in the window. capcomd Desktop is Swift from the first pixel to the socket, built on the frameworks macOS itself is drawn with.</p>
            <dl className="dk-native__facts">
              {NATIVE_FACTS.map(([n, what], k) => <div key={what} data-reveal style={delay(140 + 60 * k)}><dt>{n}</dt><dd>{what}</dd></div>)}
            </dl>
          </div>
          <ol className="dk-stack" aria-label="The app, from what you see down to the daemon">
            {LAYERS.map(([fw, what, how, code], k) => (
              <li key={fw} className="dk-stack__layer" data-reveal style={{ ...delay(60 * k), ["--i" as string]: k }}>
                <h3><span>{what}</span>{fw}</h3>
                <code>{code}</code>
                <p>{how}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="dk-room" id="room" aria-labelledby="room-h">
          <h2 id="room-h" className="dk-h2" data-reveal>One voice to the crew.</h2>
          <p className="dk-lead dk-room__lead" data-reveal style={delay(80)}>
            In Apollo&apos;s Mission Control every controller watched a console of their own, and one of them, the capsule communicator, spoke to the crew. capcomd is named after that seat. The desktop app gives every agent its own station and keeps you as the voice.
          </p>
          <figure className="dk-room__wide" data-reveal style={delay(140)}>
            <div className="dk-drift"><img src="/desktop/mcc-apollo7.jpg" width={1920} height={1266} alt="Rows of consoles in Mission Control, Houston, each with a controller at it, the world map lit on the front wall." loading="lazy" decoding="async" /></div>
            <figcaption>Mission Operations Control Room, Houston, on the first day of Apollo 7, 11 October 1968.</figcaption>
          </figure>
          <div className="dk-room__tile" data-reveal style={delay(220)}>
            <img src="/desktop/mcc-apollo14.jpg" width={1920} height={1290} alt="A flight controller in a headset points at a console screen while another works through the flight plan, Apollo 14, 1971." loading="lazy" decoding="async" />
            <ul>
              <li><h3>A station per agent.</h3><p>Seventeen agents, seventeen columns, in tree order.</p></li>
              <li><h3>One voice, yours.</h3><p>Every question an agent asks comes to you, and only those.</p></li>
              <li><h3>Eyes where needed.</h3><p>Follow moves the reel only for an ask or a failure.</p></li>
            </ul>
          </div>
        </section>

        <ColumnLab />
        <StartLumen />
        <Decks />
        <Keys />

        <figure className="dk-rest" aria-labelledby="rest-cap">
          <div className="dk-drift dk-drift--wide"><img src="/desktop/mcc-consoles.jpg" width={1920} height={1285} alt="The row of Apollo consoles in Historic Mission Control, their screens dark, hundreds of square keys along the desk." loading="lazy" decoding="async" /></div>
          <figcaption id="rest-cap"><span>The Apollo consoles in Historic Mission Control, Houston: one station, one controller, a desk of keys.</span><span>Photograph: Mike Renlund, CC BY 2.0</span></figcaption>
        </figure>

        <section className="dk-budgets" id="budgets" aria-labelledby="budgets-h">
          <div className="dk-budgets__head">
            <h2 id="budgets-h" className="dk-h2" data-reveal>Fast is the feature.</h2>
            <p data-reveal style={delay(80)}>Performance first, then speed, then design. These are the budgets the app is built to. A change that misses one doesn&apos;t ship, however good it looks.</p>
          </div>
          <dl className="dk-ledger">
            {BUDGETS.map(([n, frac, unit, what], k) => (
              <div key={what} className="dk-ledger__row" data-reveal style={delay(80 * k)}>
                <dt><span className="dk-ledger__n">{n}</span><span className="dk-ledger__f">{frac}</span><span className="dk-ledger__u">{unit}</span></dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="dk-prof" id="profiler" aria-labelledby="prof-h">
          <div className="dk-prof__head">
            <h2 id="prof-h" className="dk-h2" data-reveal>Measured, not promised.</h2>
            <p data-reveal style={delay(80)}>An agent tuned the reel with DeskBench, the app&apos;s own bench. It drives the real window through 17 agents while xctrace samples the main thread every millisecond. A change stayed only if it beat the noise. Main-thread CPU fell by two thirds.</p>
          </div>
          <div data-reveal style={delay(120)}><PerfStrips /></div>
          <dl className="dk-readouts">
            {READOUTS.map(([was, now, unit, what], k) => (
              <div key={what} data-reveal style={delay(60 * k)}>
                <dt><span className="dk-was">{was}</span><span className="dk-arr" aria-label="became"> → </span>{now}<small>{unit}</small></dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <div className="dk-prof__foot">
            <div data-reveal>
              <h3>Four fixes survived the A/B runs.</h3>
              <ul className="dk-fixes">{FIXES.map((f) => <li key={f}>{f}</li>)}</ul>
              <p className="dk-prof__dropped">Three more ideas were tested and dropped: one changed nothing, one came from a stale trace, and one was an artefact of how late frames are counted.</p>
            </div>
            <div className="dk-prof__over" data-reveal style={delay(80)}>
              <h3>Still over budget.</h3>
              <p>A project switch takes 170 ms against a budget of 50, and the frames right after it are still heavy. The profiles already name what comes next.</p>
              <p><a href="/desktop/perf/">Read the whole perf log</a></p>
            </div>
          </div>
        </section>

        <section className="dk-today" id="today" aria-labelledby="today-h">
          <div className="dk-today__pic">
            <img src="/desktop/real-window.jpg" width={2880} height={1776} alt="The capcomd Desktop window in the current build: a crew of 17 agents in the title bar, with the planner, a lead and a worker as columns of messages, diffs and tool calls." loading="lazy" decoding="async" />
          </div>
          <div className="dk-today__words">
            <h2 id="today-h" className="dk-h2" data-reveal>The window today.</h2>
            <p data-reveal style={delay(80)}>Drawn by the app&apos;s own test bench from the current build, with 17 agents of generated work. capcomd Desktop is in development; the first build will come out on GitHub. Until then, the CLI and the menu bar app run every crew on this page.</p>
            <p className="dk-today__act" data-reveal style={delay(160)}>
              <a className="button" href={SITE.repo}>Watch on GitHub</a>
              <a href="/#install">Install the CLI</a>
            </p>
          </div>
        </section>
      </main>
      <Footer credits={CREDITS} />
      <Reveals />
    </>
  );
}
