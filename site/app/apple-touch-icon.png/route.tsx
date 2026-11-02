import { ImageResponse } from "next/og";
import { faviconSvg } from "@/lib/marks";

// /apple-touch-icon.png, written to the export at build time: the menu bar bot mark on an opaque plum square
// (iOS draws its own rounded corners).
export const dynamic = "force-static";
const size = { width: 180, height: 180 };

export function GET() {
  const svg = faviconSvg().replace('rx="3" ', "").replace("<svg ", '<svg width="144" height="144" ');
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#2B0E57" }}>
        <img src={`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`} width={144} height={144} alt="" />
      </div>
    ),
    size,
  );
}
