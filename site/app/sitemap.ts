import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/` }, { url: `${SITE_URL}/desktop/` }, { url: `${SITE_URL}/desktop/perf/` }, { url: `${SITE_URL}/perfloop/` }, { url: `${SITE_URL}/bots/` }];
}
