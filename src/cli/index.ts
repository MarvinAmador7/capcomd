#!/usr/bin/env bun
// The CLI's dispatcher (plugin API §4.7.1, §17.2 step 8). It answers the host's own commands (serve, plugins, help,
// version, tui) itself; every other command is a registration: the built-in front doors (src/plugins/front/) register
// the kernel's groups, and a plugin may add a group of its own. A kernel command is parsed with the kernel's flag table
// (src/cli/flags.ts) and prints its own output; a plugin's command answers with a relay.v1 envelope (src/cli/front-doors.ts).
import "./apply-config";
import "./quiet";
import { parseArgs } from "util";
import { RelayError, SCHEMA, EXIT, toRelayError } from "../core/errors";
import { FLAGS } from "./flags";
import { commandHelp, HELP } from "./help";
import { DISPATCHER_COMMANDS, frontDoor, OPERATOR, parseLoose, pluginHelp, printAnswer, runPluginCommand } from "./front-doors";

async function main(argv: string[]): Promise<number> {
  // `capcomd tui …`: the terminal debugger takes its own flags (apps/tui/src/run.tsx).
  if (argv[0] === "tui") {
    const { runTui } = await import("../../apps/tui/src/run");
    const O = await import("../primitives/ops");
    return runTui(argv.slice(1), { cli: (await import("../utils/self")).selfArgv(), latestRun: () => O.recentRuns(1)[0]?.runId ?? null });
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: FLAGS, allowPositionals: true, strict: true });
  } catch (error) {
    // A plugin's command takes flags the kernel's table doesn't know.
    const word = parseLoose(argv).positionals[0];
    const door = word && !(DISPATCHER_COMMANDS as readonly string[]).includes(word) ? await frontDoor(word).catch(() => null) : null;
    if (door && !door.kernel) return runPluginCommand(door, argv);
    const err = new RelayError("usage", error instanceof Error ? error.message : String(error), "Run `capcomd --help` for usage.");
    const wantsJson = argv.includes("--json");
    if (wantsJson) console.log(JSON.stringify(err.toJSON()));
    else console.error(`Error: ${err.message}\n${err.hint}`);
    return err.exitCode;
  }
  const { values, positionals } = parsed;
  const json = !!values.json;
  const command = positionals[0];
  const out = (obj: Record<string, unknown>) => console.log(JSON.stringify({ schema: SCHEMA, ok: true, ...obj }));

  try {
    if (values.version || command === "version") {
      const version = (await import("../utils/self")).VERSION;
      if (json) out({ version }); else console.log(`capcomd ${version}`);
      return EXIT.ok;
    }
    if (values.help || !command) {
      console.log((command && (commandHelp(command) ?? (await pluginHelp(command)))) || HELP + (await pluginHelp(null)));
      return command || values.help ? EXIT.ok : EXIT.usage;
    }
    if (command === "serve") {
      await (await import("./commands/serve")).serve({ port: parseInt(values.port as string, 10), ...(values["harness-socket"] ? { harnessSocket: values["harness-socket"] as string } : {}) });
      return EXIT.ok;
    }
    if (command === "plugins") {
      const { pluginsCommand } = await import("./commands/plugins");
      return await pluginsCommand(positionals, { json, conformance: !!values.conformance });
    }
    const door = await frontDoor(command);
    if (!door) throw new RelayError("usage", `unknown command: ${command}`, "Run `capcomd --help` for usage.");
    if (!door.kernel) return runPluginCommand(door, argv);
    // A kernel command: the kernel's flag table parsed it; it prints its own output (`{exit}`) or answers an envelope.
    return printAnswer(door, await door.spec.run({ args: positionals.slice(1), flags: values as Record<string, string | boolean | string[]>, json, principal: OPERATOR, signal: new AbortController().signal }), json);
  } catch (error) {
    const err = toRelayError(error);
    if (json) console.log(JSON.stringify(err.toJSON()));
    else console.error(`\n✗ ${err.message}\n  ${err.hint}`);
    return err.exitCode;
  }
}

const code = await main(process.argv.slice(2));
// What a verify's gates left going (a reviewer to stop, a denial to record) finishes before this process does.
await (await import("../plugins/hooks")).settled();
if (code !== 0 || !["serve", "ui", "mcp"].includes(process.argv[2] ?? "")) process.exit(code);
