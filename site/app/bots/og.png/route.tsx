import { ImageResponse } from "next/og";
import { botSvg } from "@/lib/vendor/bot-avatar.js";
import { wordmarkSvg } from "@/lib/marks";
import { googleFont } from "@/lib/og-fonts";

// /bots/og.png, written at build time: a generic card for the playground (a static export can't render one per bot).
export const dynamic = "force-static";
const size = { width: 1200, height: 630 };
const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const ROW: Array<[string, string, string?]> = [["agt-7e9410", "planner", "wave"], ["agt-30557", "worker"], ["agt-53225", "critic", "spark"], ["agt-1f3a", "lead"], ["agt-19223", "worker"], ["agt-20ddf", "other", "cheer"]];

export async function GET() {
  const bots = ROW.map(([seed, role, pose]) => botSvg({ seed, role, size: "full", pose, decorative: true }).replace(/ width="\d+" height="\d+"/, ' width="160" height="160"'));
  const floor = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="64" shape-rendering="crispEdges"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#47208A"/><rect x="5" y="5" width="5" height="5" fill="#47208A"/></pattern></defs><rect width="1200" height="64" fill="url(#p)"/></svg>';
  const mark = wordmarkSvg().replace('fill="currentColor"', 'fill="#F3F0F8"').replace("<svg ", '<svg width="190" height="21" ');
  const [bebas, garamond] = await Promise.all([googleFont("Bebas Neue"), googleFont("EB Garamond")]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#2B0E57", color: "#F3F0F8", position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "48px 56px 0" }}>
          <img src={uri(mark)} width={190} height={21} alt="" />
          <span style={{ fontFamily: "Garamond", fontSize: 30, color: "#FFB566" }}>Bot playground</span>
        </div>
        <div style={{ display: "flex", fontFamily: "Bebas", fontSize: 200, lineHeight: 1, padding: "26px 56px 0", letterSpacing: -2 }}>PULL A BOT.</div>
        <img src={uri(floor)} width={1200} height={64} alt="" style={{ position: "absolute", left: 0, bottom: 0 }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 20, display: "flex", justifyContent: "space-around", padding: "0 40px" }}>
          {bots.map((b, i) => <img key={i} src={uri(b)} width={160} height={160} alt="" />)}
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: "Bebas", data: bebas, weight: 400 }, { name: "Garamond", data: garamond, weight: 400 }] },
  );
}
