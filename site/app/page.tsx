import { AtScale } from "@/components/AtScale";
import { CrewProvider } from "@/components/crew";
import { Drive } from "@/components/Drive";
import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { Patterns } from "@/components/Patterns";
import { Reveals } from "@/components/Reveals";
import { RoleTree } from "@/components/RoleTree";
import { Run } from "@/components/Run";
import { Sandboxes } from "@/components/Sandboxes";
import { VERSION } from "@/lib/version";

export default function Home() {
  return (
    <CrewProvider>
      <a className="skip" href="#main">Skip to content</a>
      <Hero version={VERSION} />
      <main id="main" tabIndex={-1}>
        <Run />
        <Sandboxes />
        <RoleTree />
        <AtScale />
        <Patterns />
        <Drive />
      </main>
      <Footer />
      <Reveals />
    </CrewProvider>
  );
}
