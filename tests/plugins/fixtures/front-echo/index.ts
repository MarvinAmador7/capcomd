// Test front door (tests/plugins/front-doors.test.ts, loaded with CAPCOMD_TEST_PLUGINS by the CLI and `capcomd mcp`):
// `capcomd echo …` and the tool `capcomd_echo_whoami` answer with the caller's principal and what they were given, as
// a relay.v1 envelope (plugin API §4.7.1, §4.7.2, §11.2). `capcomd echo missing` throws a PluginError; `capcomd echo
// bare` answers without an envelope.
import { definePlugin, PluginError } from "../../../../packages/plugin/src/index";

export const plugin = definePlugin({
  activate(ctx) {
    ctx.cli.command({
      name: "echo", summary: "Say who called and what it was given", usage: ["capcomd echo [words…] [--flag value]"],
      async run({ args, flags, json, principal }) {
        if (args[0] === "missing") throw new PluginError("not_found", `nothing called ${args[1] ?? "that"}`, "Try `capcomd echo hello`.");
        if (args[0] === "bare") return { ok: true } as never;
        return { schema: "relay.v1", ok: true, principal, args, flags, json, plugin: ctx.principal, text: `${principal.kind} said: ${args.join(" ")}` };
      },
    });
    ctx.mcp.tool({
      name: "whoami", title: "Who am I", description: "Say who called and what it was given.",
      inputSchema: { type: "object", properties: { say: { type: "string", minLength: 1 } }, required: ["say"] },
      annotations: { readOnlyHint: true },
      async run({ args, principal }) {
        if (args.say === "fail") throw new PluginError("forbidden", "not for you", "Ask the operator.");
        return { schema: "relay.v1", ok: true, principal, args };
      },
    });
    ctx.mcp.instructions("Echo answers with who called it.");
  },
});
