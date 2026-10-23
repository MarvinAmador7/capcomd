// Running capcomd again (the engine, agent drivers, detached runs, the service): the single executable runs itself;
// from a checkout or the npm package it is `bun src/cli/index.ts`.
import { join } from "path";
import pkg from "../../package.json" with { type: "json" };
import { COMPILED, PACKAGE_ROOT } from "./home";

/** The CLI's entry point when running from source (a checkout or the npm package). */
export const CLI_ENTRY = join(PACKAGE_ROOT, "src", "cli", "index.ts");

/** argv that runs this capcomd with `args`. */
export function selfArgv(...args: string[]): string[] {
  return COMPILED ? [process.execPath, ...args] : [process.execPath, CLI_ENTRY, ...args];
}

/** The version, compiled in (the binary has no package.json next to it). */
export const VERSION: string = pkg.version;
