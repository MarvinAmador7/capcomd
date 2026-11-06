// front-hermes (plugin API §17.1, §17.2 step 8): the built-in front door that puts capcomd in Hermes (Nous Research's
// hermes-agent). Its config writer is ./hermes-config.ts, which `capcomd setup agent` runs too (src/cli/commands/setup.ts
// `hermesStep`). Its command answers with the relay.v1 envelope, as any plugin's does (§4.7.1):
//   capcomd hermes [status]   whether Hermes is installed and has capcomd (what `capcomd setup check` says)
//   capcomd hermes add        add capcomd to Hermes now: its MCP server entry, the skills, who approves protected merges
import { definePlugin } from "../../../packages/plugin/src/context";
import type { PluginManifest } from "../../../packages/plugin/src/manifest";
import { RelayError, SCHEMA } from "../../core/errors";
import { VERSION } from "../../utils/self";

const SUMMARY = "capcomd in Hermes: whether it's set up, or add it (what `capcomd setup agent` does for Hermes)";
const USAGE = "capcomd hermes [status] | capcomd hermes add [--approvals elicit|human] [--hermes-entry-per-project] [--yes] [--json]";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "front-hermes", version: VERSION,
  description: "capcomd in Hermes (Nous Research's hermes-agent): its MCP server entry in Hermes's config, the capcomd skills in its skills directory, and who approves merges into protected branches.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./hermes.ts" }, order: "pre",
  contributes: { cli: [{ name: "hermes", summary: SUMMARY }] },
};

export const plugin = definePlugin({
  activate(ctx) {
    ctx.cli.command({
      name: "hermes", summary: SUMMARY, usage: [USAGE],
      async run({ args, flags, json }) {
        const sub = args[0] ?? "status";
        if (sub === "status") {
          const s = (await import("./hermes-config")).hermesStatus();
          return { schema: SCHEMA, ok: true, hermes: s, text: `${s.ok ? "✓" : "✗"} hermes: ${s.detail}${s.hint ? `\n  → ${s.hint}` : ""}` };
        }
        if (sub !== "add" || args.length > 1) throw new RelayError("usage", `usage: ${USAGE}`, "Run `capcomd hermes --help` for usage.");
        const { hermesStep } = await import("../../cli/commands/setup");
        const { prompter } = await import("../../cli/prompt");
        const step = await hermesStep(prompter({ yes: flags.yes === true || json }), flags as Record<string, unknown>);
        if (!step) throw new RelayError("not_found", "Hermes isn't installed here", "Install Hermes (github.com/NousResearch/hermes-agent), run `hermes setup` once, then `capcomd hermes add`.");
        if (!step.ok) throw new RelayError("config", step.detail, step.hint ?? "Run `capcomd hermes add` again once it's fixed.");
        return { schema: SCHEMA, ok: true, step, text: `✓ hermes: ${step.detail}` };
      },
    });
  },
});
