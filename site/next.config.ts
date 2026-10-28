import { resolve } from "node:path";
import type { NextConfig } from "next";

// A static export: `next build` writes plain files to out/, servable by any static host. No server features.
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  // The site has its own lockfile inside the capcomd repo; build from here, not the repo root.
  turbopack: { root: resolve(".") },
};

export default config;
