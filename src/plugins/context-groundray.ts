// context-groundray (ADR-025 §11.2, steps 4 and 5): the built-in context provider `groundray`, a company's facts from a
// brain. A profile with `context: {providers: [{name: groundray, brain: acme}]}` is briefed from the brain the project
// maps as `acme` (`capcomd context brain add acme <repo>`), at the commit the run was started with, and finds the brain's
// files in its sandbox where the brief's lines point (src/context/groundray.ts). It takes proposals too: a new draft made
// by the groundray CLI in a throwaway authoring clone, pushed to the run's proposal branch of the brain's repository and
// opened as a pull request there (src/context/groundray-write.ts); a run's consolidator proposes, and a person or the
// kernel sends them (src/context/brain-proposals.ts).
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";
import { groundrayProvider } from "../context/groundray";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "context-groundray", version: VERSION,
  description: "Business knowledge: the facts of a groundray brain (or any OKF bundle in a git repository) the project maps, as a context provider (groundray) a profile names; new facts proposed to it as drafts in pull requests on the brain's repository, through the groundray CLI.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./context-groundray.ts" },
  provides: ["context:groundray"],
  contributes: { context: [{ name: "groundray", kinds: ["fact"] }] },
};

export const plugin = definePlugin({
  activate(ctx) {
    ctx.context.register(groundrayProvider());
  },
});
