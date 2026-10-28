// The one place the site's origin is set (no trailing slash): canonical, Open Graph, robots and sitemap URLs.
export const SITE_URL = "https://capcomd.vercel.app";

export const SITE = {
  name: "capcomd",
  title: "capcomd · durable orchestration for swarms of coding agents",
  ogTitle: "capcomd: put a crew on it",
  description:
    "Durable orchestration for swarms of coding agents: one VM and branch per agent, operator-owned checks and a reviewer agent, exactly-once merges of the commit that passed.",
  repo: "https://github.com/MarvinAmador7/capcomd",
  /** The licence line shown under the playground. */
  license: "capcomd is open source, released under the MIT License.",
} as const;
