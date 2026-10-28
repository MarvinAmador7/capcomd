import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** capcomd's version as "major.minor", read from the repository's package.json at build time. */
export const VERSION: string = (JSON.parse(readFileSync(join(process.cwd(), "..", "package.json"), "utf8")) as { version: string })
  .version.split(".").slice(0, 2).join(".");
