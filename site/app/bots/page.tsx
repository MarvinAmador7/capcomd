import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { Playground } from "@/components/playground/Playground";
import { Reveals } from "@/components/Reveals";
import { SITE } from "@/lib/site";
import { ROLES, countCombinations, type Role } from "@/lib/vendor/bot-avatar.js";

const title = "Bot playground · capcomd";
const description = "Every capcomd agent gets a pixel bot drawn from its id. Pull one, change any of its 14 parts, keep a crew, and download or share it.";

export const metadata: Metadata = {
  title, description,
  alternates: { canonical: "/bots/" },
  openGraph: {
    type: "website", siteName: SITE.name, title: "Pull a bot · capcomd", description, url: "/bots/",
    images: [{ url: "/bots/og.png", width: 1200, height: 630, alt: "A row of capcomd pixel bots on a dithered floor: pull a bot." }],
  },
  twitter: { card: "summary_large_image", title: "Pull a bot · capcomd", description, images: ["/bots/og.png"] },
};

// How many different bots each role can get, counted by the engine at build time.
const counts = Object.fromEntries(ROLES.map((r) => [r, countCombinations(r)])) as Record<Role, number>;

export default function BotsPage() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="pg-head">
        <Nav home={false} current="bots" />
        <div className="pg-head__copy">
          <h1 className="pg-head__title" data-reveal>Pull a bot.</h1>
          <p className="pg-head__lead" data-reveal style={{ ["--d" as string]: "80ms" }}>Every capcomd agent gets a pixel bot drawn from its id: same id, same bot, forever (in a crew, a sibling that would look like another gets a variant). This is the engine that draws them. Pull one, change any of its 14 parts, keep a crew, and take them with you.</p>
          <p className="pg-head__note" data-reveal style={{ ["--d" as string]: "140ms" }}>The role changes the odds: planners always get the crown and leads the flag; critics lean purple, square heads, dishes, monocles and the spark pose; workers lean hats, headlamps and treads. Everything runs in your browser; nothing is sent anywhere.</p>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="pg-main">
        <noscript><p className="pg__noscript">The playground needs JavaScript. Here is one bot, drawn from <code>agt-7e9410</code>.</p></noscript>
        <Playground initialSeed="agt-7e9410" counts={counts} />
      </main>
      <Footer />
      <Reveals />
    </>
  );
}
