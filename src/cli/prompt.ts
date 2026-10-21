// Minimal terminal prompts for `capcomd setup` (no dependencies). Without a terminal (or with --yes) every
// prompt returns its default without blocking, so agents and scripts can run setup non-interactively.
import { createInterface } from "readline";

export interface Prompter {
  interactive: boolean;
  ask(question: string, dflt?: string): Promise<string>;
  confirm(question: string, dflt: boolean): Promise<boolean>;
  choose<T extends string>(question: string, options: Array<{ value: T; label: string }>, dflt: T): Promise<T>;
  secret(question: string): Promise<string>;
}

export function prompter(o: { yes?: boolean; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {}): Prompter {
  const input = o.input ?? process.stdin;
  const output = o.output ?? process.stdout;
  const interactive = !o.yes && !!input.isTTY && !!output.isTTY;
  const line = (q: string) => new Promise<string>((res) => {
    const rl = createInterface({ input, output, terminal: true });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });
  return {
    interactive,
    async ask(question, dflt = "") {
      if (!interactive) return dflt;
      const a = await line(`${question}${dflt ? ` [${dflt}]` : ""}: `);
      return a || dflt;
    },
    async confirm(question, dflt) {
      if (!interactive) return dflt;
      const a = (await line(`${question} ${dflt ? "[Y/n]" : "[y/N]"}: `)).toLowerCase();
      return a ? a.startsWith("y") : dflt;
    },
    async choose(question, options, dflt) {
      if (!interactive) return dflt;
      output.write(`${question}\n`);
      options.forEach((opt, i) => output.write(`  ${i + 1}) ${opt.label}${opt.value === dflt ? "  (default)" : ""}\n`));
      const a = await line("Choose: ");
      const n = Number(a);
      return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1]!.value : (options.find((x) => x.value === a)?.value ?? dflt);
    },
    // Hidden input: echo off while typing, nothing of the value is printed.
    async secret(question) {
      if (!interactive) return "";
      output.write(`${question}: `);
      return await new Promise<string>((res) => {
        let v = "";
        const raw = input.isRaw;
        input.setRawMode?.(true);
        input.resume();
        const onData = (b: Buffer) => {
          for (const ch of b.toString("utf8")) {
            if (ch === "\r" || ch === "\n") { done(); return; }
            if (ch === "\u0003") { done(); process.exit(130); }
            if (ch === "\u007f" || ch === "\b") v = v.slice(0, -1);
            else if (ch >= " ") v += ch;
          }
        };
        const done = () => { input.off("data", onData); input.setRawMode?.(raw ?? false); input.pause(); output.write("\n"); res(v.trim()); };
        input.on("data", onData);
      });
    },
  };
}
