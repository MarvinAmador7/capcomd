// context-groundray (ADR-025 §11.2, step 4): the built-in context provider `groundray`, a company's facts from a brain.
// A profile with `context: {providers: [{name: groundray, brain: acme}]}` is briefed from the brain the project maps as
// `acme` (`capcomd context brain add acme <repo>`), at the commit the run was started with, and finds the brain's files
// in its sandbox where the brief's lines point (src/context/groundray.ts). Read-only in this step: proposals to a brain
// come with ADR-025 step 5.
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";
import { groundrayProvider } from "../context/groundray";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "context-groundray", version: VERSION,
  description: "Business knowledge: the facts of a groundray brain (or any OKF bundle in a git repository) the project maps, as a context provider (groundray) a profile names.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./context-groundray.ts" },
  provides: ["context:groundray"],
  contributes: { context: [{ name: "groundray", kinds: ["fact"] }] },
};

export const plugin = definePlugin({
  activate(ctx) {
    ctx.context.register(groundrayProvider());
  },
});
