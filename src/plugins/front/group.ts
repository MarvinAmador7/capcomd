// A built-in front door for a group of the kernel's CLI commands (plugin API §4.7.1, §17.1 "one front-<group> per
// group"): its manifest declares the commands and its `activate` registers them (`ctx.cli.command`). A command's code
// is its group module in src/cli/groups/, imported when the command runs, so the CLI's start stays as cheap as before.
// It prints its own output and answers `{exit}` (a kernel front door's form, `CliExit`).
import { definePlugin, type CliCommandSpec, type PluginModule } from "../../../packages/plugin/src/context";
import type { PluginManifest } from "../../../packages/plugin/src/manifest";
import type { KernelCommand } from "../../cli/groups/common";
import { VERSION } from "../../utils/self";

export interface KernelCommandDecl {
  name: string;
  /** One line for `capcomd plugins list` and the manifest (at most 120 characters). */
  summary: string;
}

/** The usage lines `capcomd --help` has for `name` (src/cli/help.ts): the lines under `  capcomd <name>`. */
export function usageOf(name: string, help: string): string[] {
  const lines = help.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^ {2}capcomd ${name.replace(/[-]/g, "\\-")}(\\s|$)`).test(lines[i]!)) continue;
    out.push(lines[i]!.trim());
    while (i + 1 < lines.length && /^ {6,}\S/.test(lines[i + 1]!) && !/^ {2}capcomd /.test(lines[i + 1]!)) out.push(lines[++i]!.trim());
  }
  return out;
}

/** A front-door built-in: its manifest, its module, and the commands its group module answers. */
export function kernelGroup(o: { name: string; description: string; commands: KernelCommandDecl[]; load: () => Promise<Record<string, KernelCommand>> }): { manifest: PluginManifest; module: PluginModule } {
  const manifest: PluginManifest = {
    schema: "capcomd.plugin/v1", name: o.name, version: VERSION, description: o.description, apiVersion: 1,
    engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./group.ts" }, order: "pre",
    contributes: { cli: o.commands.map((c) => ({ name: c.name, summary: c.summary })) },
  };
  const module = definePlugin({
    async activate(ctx) {
      const { HELP } = await import("../../cli/help");
      for (const c of o.commands) {
        const spec: CliCommandSpec = {
          name: c.name, summary: c.summary, usage: usageOf(c.name, HELP),
          run: async (i) => {
            const run = (await o.load())[c.name];
            if (!run) throw new Error(`${o.name} has no ${c.name} command`);
            return { exit: await run({ command: c.name, positionals: [c.name, ...i.args], values: i.flags, json: i.json }) };
          },
        };
        ctx.cli.command(spec);
      }
    },
  });
  return { manifest, module };
}
