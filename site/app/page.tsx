import { AtScale } from "@/components/AtScale";
import { BotsCta } from "@/components/BotsCta";
import { CrewProvider } from "@/components/crew";
import { Durable } from "@/components/Durable";
import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { Patterns } from "@/components/Patterns";
import { Reveals } from "@/components/Reveals";
import { RoleTree } from "@/components/RoleTree";
import { Run } from "@/components/Run";
import { Sandboxes } from "@/components/Sandboxes";
import { Start } from "@/components/Start";

export default function Home() {
  return (
    <CrewProvider>
      <a className="skip" href="#main">Skip to content</a>
      <Hero />
      <main id="main" tabIndex={-1}>
        <AtScale />
        <Run />
        <Durable />
        <Sandboxes />
        <RoleTree />
        <Patterns />
        <Start />
        <BotsCta />
      </main>
      <Footer />
      <Reveals />
    </CrewProvider>
  );
}
