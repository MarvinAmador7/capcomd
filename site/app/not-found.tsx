import type { Metadata } from "next";
import { Wordmark } from "@/components/marks";
import { DEFAULT_SEED } from "@/lib/crew";
import { SITE } from "@/lib/site";
import { botSvg } from "@/lib/vendor/bot-avatar.js";

export const metadata: Metadata = { title: "Not found · capcomd", robots: { index: false } };

// The planner, asleep: nothing was spawned here.
const sleepy = botSvg({ seed: `${DEFAULT_SEED}/0`, role: "planner", size: "full", mood: "sleepy", decorative: true }).replace(/ width="\d+" height="\d+"/, "");

export default function NotFound() {
  return (
    <div className="nf">
      <header className="nav" aria-label="Site">
        <Wordmark className="nav__mark" />
        <a className="button" href="/#install">Install</a>
      </header>
      <main className="nf__main">
        <div className="nf__bot" aria-hidden="true"><span className="floor" /><span dangerouslySetInnerHTML={{ __html: sleepy }} /></div>
        <h1 className="nf__title"><span>No agent</span> <span>at this address.</span></h1>
        <p className="nf__text">The page you asked for isn&apos;t here. Nothing was spawned, nothing was merged.</p>
        <p className="nf__links"><a className="button" href="/">Back to the crew</a> <a className="text" href={SITE.repo}>capcomd on GitHub</a></p>
      </main>
    </div>
  );
}
