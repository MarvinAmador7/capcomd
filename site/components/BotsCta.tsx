"use client";

// The page's close: a lineup of pixel bots on the slot's dithered floor, and the way into the bot builder (/bots/).
// Each bot is drawn by the engine from its own id and opens in the builder; "Pull another lineup" draws new ids. The
// static HTML carries a fixed lineup, so the section reads the same without the script.
import { useState } from "react";
import { botSvg, botTeam, countCombinations, type BotTraits, type Role } from "@/lib/vendor/bot-avatar.js";
import { encode, randomSeed } from "@/lib/playground";
import { delay } from "./marks";

const ROLES: Role[] = ["planner", "worker", "critic", "lead", "worker", "other"];
const FIXED = ["agt-7e9410", "agt-2c41f8", "agt-b03d5e", "agt-91aa07", "agt-5f6e2b", "agt-d8c113"];
// One team, as in the app: botTeam keeps the bots of a lineup apart (different names and looks).
const svg = (t: BotTraits, happy: boolean) =>
  botSvg({ seed: t.seed, role: t.role, size: "full", traits: t, decorative: true, ...(happy ? { mood: "happy" as const, pose: "wave" } : {}) }).replace(/ width="\d+" height="\d+"/, "");
// "over 500 million": the engine's own count of different worker bots, rounded down to the hundred million.
const WORKERS = Math.floor(countCombinations("worker") / 1e8) * 100;

export function BotsCta() {
  const [seeds, setSeeds] = useState<string[]>(FIXED);
  const [pulls, setPulls] = useState(0);
  return (
    <section className="bcta" id="bots-cta" aria-labelledby="bcta-title">
      <div className="bcta__top">
        <h2 className="big" id="bcta-title" data-reveal><span>Every agent</span> <span>gets a bot.</span></h2>
        <div className="bcta__copy" data-reveal style={delay(80)}>
          <p>Drawn from the agent&apos;s id: 14 parts, over {WORKERS} million different workers. Change any part, keep a crew, download it or share the link.</p>
          <div className="bcta__do">
            <a className="button bcta__go" href="/bots/">Open the bot builder</a>
            <button type="button" className="bcta__pull" onClick={() => { setSeeds(ROLES.map(() => randomSeed())); setPulls((n) => n + 1); }}>Pull another lineup</button>
          </div>
        </div>
      </div>
      <ul className="bcta__line" key={pulls} aria-label="A lineup of bots; each opens in the builder">
        {botTeam(seeds.map((seed, i) => ({ seed, role: ROLES[i]! }))).map((t, i) => {
          const role = t.role;
          return (
            <li key={t.seed} style={{ ["--k" as string]: i }}>
              <a href={`/bots/#${encode(t, "full")}`} aria-label={`${t.name}, a ${role}: open in the bot builder`}>
                <span className="bcta__bot" aria-hidden="true">
                  <span className="bcta__rest" dangerouslySetInnerHTML={{ __html: svg(t, false) }} />
                  <span className="bcta__hi" dangerouslySetInnerHTML={{ __html: svg(t, true) }} />
                </span>
                <span className="bcta__name" aria-hidden="true">{t.name}<small>{role}</small></span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
