// The one place the site's origin is set. TODO(owner): replace the placeholder with the real domain once it's
// decided (no trailing slash). It's used for canonical, Open Graph, robots and sitemap URLs only.
export const SITE_URL = "https://capcomd.example";

export const SITE = {
  name: "capcomd",
  title: "capcomd · durable orchestration for swarms of coding agents",
  ogTitle: "capcomd: put a crew on it",
  description:
    "Durable orchestration for swarms of coding agents: one VM and branch per agent, operator-owned checks and a reviewer agent, exactly-once merges of the commit that passed.",
  repo: "https://github.com/MarvinAmador7/capcomd",
} as const;
