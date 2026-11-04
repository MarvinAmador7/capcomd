import type { Metadata } from "next";
import "./desktop.css";
import { HeroReel } from "@/components/desktop/HeroReel";
import { StartLumen } from "@/components/desktop/StartLumen";
import { Tiles } from "@/components/desktop/Tiles";
import { Footer } from "@/components/Footer";
import { delay } from "@/components/marks";
import { Nav } from "@/components/Nav";
import { Reveals } from "@/components/Reveals";
import { SITE } from "@/lib/site";

const title = "capcomd Desktop · in command of the swarm";
const description = "capcomd Desktop is the native Mac app for capcomd's orchestration engine. Every agent in a swarm gets a live column; the engine reviews and merges, and brings you only the decisions that are yours. In development.";

export const metadata: Metadata = {
  title, description,
  alternates: { canonical: "/desktop/" },
  openGraph: { type: "website", siteName: SITE.name, title: "capcomd Desktop", description, url: "/desktop/", images: [{ url: "/og.png", width: 1200, height: 630, alt: "capcomd's crew of pixel bots." }] },
  twitter: { card: "summary_large_image", title: "capcomd Desktop", description, images: ["/og.png"] },
};

// Native, fast, measured: three figures, each from the page's sources (CONTENT.md): the app has no web view and no
// other language; Core Animation draws a slide at the panel's 120 Hz; DeskBench cut main-thread CPU by two thirds.
const FIGURES: Array<[string, string]> = [
  ["0", "web views. Swift from the first pixel to the socket."],
  ["120 Hz", "slides, drawn by Core Animation on ProMotion."],
  ["⅔", "less main-thread work, measured by the app's own bench."],
];

export default function DesktopPage() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="dt-hero">
        <Nav home={false} current="desktop" />
        <div className="dt-hero__words">
          <h1 className="dt-h1" data-load style={delay(60)}>capcomd Desktop</h1>
          <p className="dt-sub" data-load style={delay(140)}>The Mac app for capcomd&apos;s orchestration engine.</p>
          <p className="dt-act" data-load style={delay(220)}>
            <a className="button" href={SITE.repo}>Watch on GitHub</a>
            <span>In development. The engine runs today from the CLI: <a href="/#install">install it</a>.</span>
          </p>
        </div>
        <div className="dt-hero__win" data-load style={delay(320)}><HeroReel /></div>
      </header>

      <main id="main" tabIndex={-1}>
        <StartLumen />
        <Tiles />

        <section className="dt-eng" id="native" aria-labelledby="eng-h">
          <h2 id="eng-h" className="dt-h2" data-reveal>Native. Fast. Measured.</h2>
          <dl className="dt-figs">
            {FIGURES.map(([n, what], k) => <div key={n} data-reveal style={delay(80 * k)}><dt>{n}</dt><dd>{what}</dd></div>)}
          </dl>
          <p className="dt-more" data-reveal><a href="/desktop/perf/">Read the perf log</a> <span aria-hidden="true">·</span> <a href="/perfloop/">Meet PerfLoop</a></p>
        </section>

        <section className="dt-today" id="today" aria-labelledby="today-h">
          <h2 id="today-h" className="dt-h2" data-reveal>The window today.</h2>
          <p className="dt-sub" data-reveal style={delay(60)}>From the current build, with 17 agents of generated work.</p>
          <figure className="dt-today__pic" data-reveal style={delay(120)}>
            <img src="/desktop/real-window.jpg" width={2880} height={1776} alt="The capcomd Desktop window in the current build: a crew of 17 agents in the title bar, with the planner, a lead and a worker as columns of messages, diffs and tool calls." loading="lazy" decoding="async" />
          </figure>
        </section>

        <section className="dt-close" aria-labelledby="close-h">
          <h2 id="close-h" className="dt-h2" data-reveal>Coming to your Mac.</h2>
          <p className="dt-sub" data-reveal style={delay(60)}>The first build will come out on GitHub. Until then, the engine runs every swarm on this page from the CLI.</p>
          <p className="dt-act" data-reveal style={delay(120)}>
            <a className="button" href={SITE.repo}>Watch on GitHub</a>
            <a href="/#install">Install the CLI</a>
          </p>
        </section>
      </main>
      <Footer />
      <Reveals />
    </>
  );
}
