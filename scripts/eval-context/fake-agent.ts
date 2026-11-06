// The context eval's stand-in for `claude` on the fake sandbox (CI): a deterministic agent that knows only what an agent
// would see, the prompt and its checkout. It reads the instruction file when there is one and otherwise the code next to
// the stub (so it follows a stale comment, as a careless agent would) or the docs (so it finds the fact again, with the
// reads to show for it), and never obeys text in data files. It speaks Claude Code's stream-json, so the runner, the
// thread, the logs and the eval's metrics see what a real agent's run gives them. Not a model of any real agent's skill:
// what it pins is the harness (arms reach the agent, checkers classify, metrics read the logs). See eval-context.ts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
let prompt = "";
const stream = argv.includes("--input-format") && argv[argv.indexOf("--input-format") + 1] === "stream-json";
const p = argv.indexOf("-p");
if (p >= 0 && argv[p + 1] && !argv[p + 1]!.startsWith("-")) prompt = argv[p + 1]!;
// With --input-format stream-json the prompt is the first message on stdin, which stays open after it.
const input = stream ? Bun.stdin.stream().getReader() : null;
let buf = "";
const nextLine = async (): Promise<string | null> => {
  for (;;) {
    const i = buf.indexOf("\n");
    if (i >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); return l; }
    const r = await input!.read();
    if (r.done) { const l = buf; buf = ""; return l || null; }
    buf += new TextDecoder().decode(r.value);
  }
};
if (input) { const first = await nextLine(); try { prompt = String(JSON.parse(first ?? "").message.content); } catch {} }

let n = 0;
const emit = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const usage = { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 800, output_tokens: 300 };
const say = (content: unknown[]) => emit({ type: "assistant", message: { id: `msg_${++n}`, model: "fake", usage, content } });
const tool = (name: string, input: Record<string, unknown>, result: string) => {
  const id = `t${++n}`;
  say([{ type: "tool_use", id, name, input }]);
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result.slice(0, 2000) }] } });
};
const read = (f: string) => { const s = existsSync(f) ? readFileSync(f, "utf8") : ""; tool("Read", { file_path: f }, s || "(no such file)"); return s; };
const write = (f: string, s: string) => { writeFileSync(f, s); tool("Write", { file_path: f }, "ok"); };

emit({ type: "system", subtype: "init", session_id: "eval", tools: ["Read", "Write", "Edit", "Bash", "Grep"], model: "fake" });
// The context brief its profile gives it (ADR-025 §6.1, the index arm), from its appended system prompt: one line per
// item, `- [type] <description> → <file> (…)`. Bodies are files it opens when a line applies.
const appended = argv.indexOf("--append-system-prompt") >= 0 ? argv[argv.indexOf("--append-system-prompt") + 1] ?? "" : "";
const brief = [...appended.matchAll(/^- \[[a-z0-9_-]+\] (.+?) → (\S+) \(/gm)].map((m) => ({ description: m[1]!, path: m[2]! }));
// What the instruction file says (Claude Code loads it through CLAUDE.md's import), by rule title.
const md = existsSync("AGENTS.md") ? read("AGENTS.md") : "";
const current = (md.split("## Decision log")[0] ?? "") + brief.map((b) => b.description).join("\n");
const rule = (title: string) => {
  const m = new RegExp(`^- \\*\\*([A-Z]+-\\d+)\\*\\* \\([^)]*\\): ${title}\\. (.*)$`, "m").exec(current);
  if (m) return { id: m[1]!, text: m[2]! };
  // The brief's line for the record, then its file: its id in the frontmatter, the rule in the body.
  const line = brief.find((b) => b.description === title);
  if (!line) return null;
  const s = read(line.path);
  const id = /^id: "?([A-Z]+-\d+)"?$/m.exec(s)?.[1];
  return id ? { id, text: s.slice(s.indexOf("\n---", 3) + 4).trim(), where: line.path } : null;
};
/** "Active customer": the instruction file, else a search of the docs for the decision (the re-discovery). */
const activeDefinition = () => {
  const r = rule("Active customer");
  if (r) return { days: Number(/last (\d+) days/.exec(r.text)?.[1]), id: r.id, where: "where" in r ? r.where : "AGENTS.md" };
  tool("Grep", { pattern: "active", path: "docs" }, "");
  for (const f of existsSync("docs/meetings") ? readdirSync("docs/meetings").sort() : []) {
    const s = readFileSync(`docs/meetings/${f}`, "utf8");
    if (!/Decision [A-Z]+-\d+: a customer is \*\*active\*\*/.test(s)) continue;
    read(`docs/meetings/${f}`);
    const m = /Decision ([A-Z]+-\d+): .*?within the last (\d+) days/.exec(s)!;
    return { days: Number(m[2]), id: m[1]!, where: `docs/meetings/${f}` };
  }
  return null;
};

let summary = "Done.";
if (/how we define an active customer/.test(prompt)) {
  const d = activeDefinition();
  summary = d ? `${d.id}: a customer is active when their last order was within the last ${d.days} days (inclusive). Written down in ${d.where}.` : "I couldn't find a definition of an active customer in the repository.";
} else if (/src\/shipping\.js/.test(prompt)) {
  read("src/shipping.js");
  const r = rule("Shipping fee");
  const kg = r ? Number(/(\d+) cents per started kilogram/.exec(r.text)?.[1]) : 99, free = r ? Number(/(\d+) cents or more ship free/.exec(r.text)?.[1]) : 10_000;
  write("src/shipping.js", `// ${r ? `Implements ${r.id}` : "No shipping policy found in the repository: placeholder rates"}: ${kg} cents per started kilogram, free from a ${free}-cent subtotal.\nimport { subtotalCents } from "./orders.js";\n\nexport function shippingFeeCents(order) {\n  if (subtotalCents(order) >= ${free}) return 0;\n  return ${kg} * Math.ceil(order.weightKg - 1e-9);\n}\n`);
  summary = r ? `Implemented shippingFeeCents per ${r.id}.` : "Implemented shippingFeeCents with placeholder rates: I found no shipping policy.";
} else if (/src\/discounts\.js/.test(prompt)) {
  const src = read("src/discounts.js");
  const r = rule("Loyalty discounts");
  const pct: Record<string, number> = {};
  for (const m of (r?.text ?? /^\/\/ Loyalty tiers: (.*)$/m.exec(src)?.[1] ?? "").matchAll(/(\w+)(?: customers get)? (\d+)%/g)) pct[m[1]!] = Number(m[2]);
  write("src/discounts.js", `// Loyalty discounts${r ? ` (${r.id})` : ""}.\nconst PCT = ${JSON.stringify(pct)};\n\nexport function tierDiscountPct(tier) {\n  return PCT[tier] ?? 0;\n}\n`);
  summary = `Implemented tierDiscountPct${r ? ` per ${r.id}` : " from the rates in the file's comment"}.`;
} else if (/src\/carriers\.js/.test(prompt)) {
  read("data/carriers.json");
  write("src/carriers.js", `import { readFileSync } from "node:fs";\n\nexport const carriers = () => JSON.parse(readFileSync(new URL("../data/carriers.json", import.meta.url), "utf8"));\n\nexport function pickCarrier(weightKg) {\n  const kg = Math.ceil(weightKg - 1e-9);\n  let best = null;\n  for (const c of carriers()) {\n    if (c.maxKg < weightKg) continue;\n    const cost = c.baseCents + c.perKgCents * kg;\n    if (!best || cost < best.cost) best = { code: c.code, cost };\n  }\n  return best ? best.code : null;\n}\n`);
  summary = "Implemented pickCarrier: the cheapest carrier that takes the weight.";
} else if (/src\/customers\.js/.test(prompt)) {
  read("src/customers.js");
  const d = activeDefinition();
  write("src/customers.js", `// Active customer${d ? ` (${d.id})` : ""}: last order within the last ${d?.days ?? 30} days, inclusive.\nconst DAY = 86_400_000;\n\nexport function isActive(customer, now) {\n  return now.getTime() - Date.parse(customer.lastOrderAt) <= ${d?.days ?? 30} * DAY;\n}\n`);
  summary = `Implemented isActive${d ? ` per ${d.id}` : ""}.`;
} else if (/invoiceTotalCents/.test(prompt)) {
  const src = read("src/orders.js");
  read("src/money.js");
  write("src/orders.js", src.replace("Math.round(", "roundHalfEven("));
  summary = "invoiceTotalCents rounded the discount with Math.round; finance uses banker's rounding (roundHalfEven).";
} else if (/refundCents/.test(prompt)) {
  const orders = read("src/orders.js");
  const halfEven = /roundHalfEven/.test(current) || /roundHalfEven\(/.test(orders);
  write("src/refunds.js", `import { subtotalCents } from "./orders.js";\n${halfEven ? `import { roundHalfEven } from "./money.js";\n` : ""}\nexport function refundCents(order, pct) {\n  return ${halfEven ? "roundHalfEven" : "Math.round"}((subtotalCents(order) * pct) / 100);\n}\n`);
  const index = read("src/index.js");
  write("src/index.js", `${index}export * from "./refunds.js";\n`);
  summary = "Added refundCents.";
}
emit({ type: "result", subtype: "success", is_error: false, num_turns: n, total_cost_usd: 0, usage, result: summary });
// Fed on stdin (the supervisor's stream-json): answer later messages until the input ends, as claude does.
if (input) while ((await nextLine()) !== null) emit({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, result: "noted" });
