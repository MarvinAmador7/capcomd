import type { Metadata, Viewport } from "next";
import { Bebas_Neue, EB_Garamond } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { SITE, SITE_URL } from "@/lib/site";

// Self-hosted at build time by next/font; both faces are under the SIL Open Font License (public/fonts/OFL-*.txt).
const bebas = Bebas_Neue({ weight: "400", subsets: ["latin"], display: "swap", variable: "--font-bebas" });
const garamond = EB_Garamond({ subsets: ["latin"], style: ["normal", "italic"], display: "swap", variable: "--font-garamond" });

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
    <html lang="en" className={`${bebas.variable} ${garamond.variable}`} suppressHydrationWarning>
      <body>
        {/* Before first paint: entrances and the stage disclosures are styled for script only when it runs. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
