// The built-in plugins (docs/spec/plugin-api.md §4.8): a static list bundled into the package and the single
// executable, each a manifest and its module imported here (src/utils/assets.ts rule: import, never read a package
// file at run time). Empty until capcomd's own providers, forges, gates and front doors become plugins (§17.2 steps 3-8).
import type { Candidate } from "../../packages/plugin/src/host/host";

export const BUILTINS: ReadonlyArray<Required<Pick<Candidate, "manifest" | "module">>> = [];
