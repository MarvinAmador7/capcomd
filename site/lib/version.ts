import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// capcomd's version as "major.minor", read at build time from the repository's root package.json (one level above
// site/). On Vercel this needs "Include files outside the root directory in the Build Step" (on by default).
const pkg = join(process.cwd(), "..", "package.json");
if (!existsSync(pkg)) throw new Error(`site: can't read capcomd's version from ${pkg}; build from site/ inside the capcomd repository`);
export const VERSION: string = (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version.split(".").slice(0, 2).join(".");
