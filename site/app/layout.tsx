import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { SITE, SITE_URL } from "@/lib/site";

// Geist, vendored from the geist package (app/fonts/) and self-hosted by next/font; SIL Open Font License
// (public/fonts/OFL-Geist.txt). Serif and Pixel ship one weight and no italic; italics come from the sans.
const serif = localFont({ src: "./fonts/GeistSerif-Regular.woff2", weight: "400", display: "swap", variable: "--font-geist-serif", fallback: ["Georgia", "serif"], adjustFontFallback: "Times New Roman" });
const sans = localFont({
  src: [{ path: "./fonts/Geist-Variable.woff2", style: "normal" }, { path: "./fonts/Geist-Italic-Variable.woff2", style: "italic" }],
  weight: "100 900", display: "swap", variable: "--font-geist-sans", fallback: ["system-ui", "sans-serif"],
});
const pixel = localFont({ src: "./fonts/GeistPixel-Square.woff2", weight: "400", display: "swap", variable: "--font-geist-pixel", fallback: ["ui-monospace", "Menlo", "monospace"], adjustFontFallback: false });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE.title,
  description: SITE.description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website", siteName: SITE.name, title: SITE.ogTitle, description: SITE.description, url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Put a crew on it: four pixel bots, a planner and its workers, standing in the headline." }],
  },
  twitter: { card: "summary_large_image", title: SITE.ogTitle, description: SITE.description, images: ["/og.png"] },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }], apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }] },
};

export const viewport: Viewport = { themeColor: "#ECEBEF" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${pixel.variable}`} suppressHydrationWarning>
      <body>
        {/* Before first paint: entrances and the stage disclosures are styled for script only when it runs. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
