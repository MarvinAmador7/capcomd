import { ImageResponse } from "next/og";
import { DEFAULT_SEED, crewSvg, crewTeam } from "@/lib/crew";
import { wordmarkSvg } from "@/lib/marks";
import { googleFont } from "@/lib/og-fonts";

// /og.png, written to the export at build time (a static GET, no server at runtime): the page's own art at
// 1200×630, the wordmark, the hero sentence with the default crew in its slot, and the line.
export const dynamic = "force-static";
const size = { width: 1200, height: 630 };

const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export async function GET() {
  const team = crewTeam(DEFAULT_SEED);
  const bots = [0, 1, 2, 3].map((i) => crewSvg(DEFAULT_SEED, team, i, "full", i === 0 ? { pose: "wave" } : {}).replace("<svg ", '<svg width="96" height="96" '));
  const floor = '<svg xmlns="http://www.w3.org/2000/svg" width="460" height="30" shape-rendering="crispEdges"><defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#47208A"/><rect x="4" y="4" width="4" height="4" fill="#47208A"/></pattern></defs><rect width="460" height="30" fill="url(#p)"/></svg>';
  const mark = wordmarkSvg().replace('fill="currentColor"', 'fill="#140B22"').replace("<svg ", '<svg width="190" height="21" ');
  const [bebas, garamond] = await Promise.all([googleFont("Bebas Neue"), googleFont("EB Garamond")]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "48px 56px", background: "#ECEBEF", color: "#140B22" }}>
        <img src={uri(mark)} width={190} height={21} alt="" />
        <div style={{ display: "flex", alignItems: "center", fontFamily: "Bebas", fontSize: 168, lineHeight: 1, letterSpacing: -2 }}>
          <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>PUT A</span>
          <div style={{ display: "flex", position: "relative", width: 440, height: 128, margin: "0 28px", flexShrink: 0, background: "#2B0E57", borderRadius: 12, overflow: "hidden", alignItems: "flex-end", justifyContent: "space-around", padding: "0 14px 6px" }}>
            <img src={uri(floor)} width={440} height={30} alt="" style={{ position: "absolute", left: 0, bottom: 0 }} />
            {bots.map((b, i) => <img key={i} src={uri(b)} width={96} height={96} alt="" />)}
          </div>
          <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>ON IT.</span>
        </div>
        <div style={{ fontFamily: "Garamond", fontSize: 34 }}>Durable orchestration for swarms of coding agents.</div>
      </div>
    ),
    { ...size, fonts: [{ name: "Bebas", data: bebas, weight: 400 }, { name: "Garamond", data: garamond, weight: 400 }] },
  );
}
