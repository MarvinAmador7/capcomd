// A scripted OpenAI-compatible Chat Completions server for recording fx ACP streams. No model: each scenario is a
// fixed list of replies, chosen by a [[scenario:NAME]] tag in the first user message; the step is the number of
// assistant messages already in the request.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.STUB_PORT || 8787);
const log = (o) => appendFileSync("/out/requests.jsonl", JSON.stringify(o) + "\n");

const text = (s, reasoning) => ({ kind: "text", text: s, reasoning });
const tool = (name, args, pre) => ({ kind: "tool", name, args, pre });
const http = (status, body, headers = {}) => ({ kind: "http", status, body, headers });

const SCENARIOS = {
  plain: [text("Hello from the stub model. The answer is 42.", "The user wants a greeting; keep it short.")],
  shell: [tool("shell", { action: "run", command: "echo hello-from-shell && ls" }, "Let me look at the files."), text("The directory has a README. Done.")],
  failing: [tool("shell", { action: "run", command: "ls /no/such/dir" }), text("That directory does not exist.")],
  edit: [tool("write_file", { path: "notes.txt", content: "first line\n" }, "I'll create the file."), tool("edit_file", { path: "notes.txt", old_string: "first line", new_string: "edited line" }), text("Created and edited notes.txt.")],
  auth: [http(401, { error: { message: "Invalid API key provided", type: "invalid_request_error", code: "invalid_api_key" } })],
  credits: [http(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } })],
  payment: [http(402, { error: { message: "Payment required: add a credit card", type: "credit_card_required", code: "credit_card_required" } })],
  ratelimit: "ratelimit",
  steer: [tool("shell", { action: "run", command: "sleep 4 && echo slept" }, "Working on it."), "echo-last-user"],
  steps: [tool("shell", { action: "run", command: "echo one" }), tool("shell", { action: "run", command: "echo two" }), tool("shell", { action: "run", command: "echo three" }), text("finished")],
  orchestrate: [
    tool("shell", { action: "run", command: "git log --oneline -1" }),
    tool("shell", { action: "run", command: "git commit -m x" }),
    tool("write_file", { path: "blocked.txt", content: "no\n" }),
    tool("shell", { action: "run", command: "capcomd status && rm -rf x" }),
    tool("shell", { action: "run", command: "uname -a" }),
    tool("shell", { action: "run", command: "echo hi > redirect.txt" }),
    tool("shell", { action: "run", command: "ls | head -1" }),
    tool("shell", { action: "run", command: "git branch -D nothing" }),
    tool("shell", { action: "run", command: "git log --output=out.txt" }),
    tool("shell", { action: "run", command: "capcomd status" }),
    tool("shell", { action: "run", command: "git status" }),
    tool("read_file", { path: "README.md" }),
    text("I looked and changed nothing."),
  ],
  mcp: [tool("mcp_capcomd_status", {}), text("capcomd says ok.")],
  path: [tool("shell", { action: "run", command: "capcomd status; echo PATH=$PATH; command -v node" }), text("checked")],
  dump: [text("ok")],
};

function scenarioOf(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join("") : "";
    const hit = /\[\[scenario:([a-z]+)\]\]/.exec(c);
    if (hit) return hit[1];
  }
  return "plain";
}

let seq = 0;
function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const messages = j.messages ?? [];
    const name = scenarioOf(messages);
    const step = messages.filter((m) => m.role === "assistant").length;
    log({ at: Date.now(), url: req.url, auth: req.headers.authorization ? "present" : "none", scenario: name, step, model: j.model, tools: (j.tools ?? []).map((t) => t.function?.name), body: name === "dump" || process.env.STUB_DUMP ? j : undefined });
    const s = SCENARIOS[name];
    if (s === "ratelimit") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      return res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
    }
    let r = s[Math.min(step, s.length - 1)];
    if (r === "echo-last-user") {
      const users = messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((x) => x.text ?? "").join("")));
      r = text(`I read your note: ${JSON.stringify(users.at(-1)?.slice(0, 200))}`);
    }
    const id = `chatcmpl-${++seq}`, model = j.model ?? "stub";
    const usage = { prompt_tokens: 1200 + step * 100, completion_tokens: 40 + step, total_tokens: 1240 + step * 101, prompt_tokens_details: { cached_tokens: step ? 1000 : 0 } };
    if (r.kind === "http") {
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      return res.end(JSON.stringify(r.body));
    }
    if (name === "steer" && step === 0) await new Promise((ok) => setTimeout(ok, 300));
    if (r.kind === "text") {
      const chunks = [];
      if (r.reasoning) chunks.push({ id, model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: r.reasoning }, finish_reason: null }] });
      const words = r.text.split(/(?<= )/);
      for (const w of words) chunks.push({ id, model, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
      chunks.push({ id, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      chunks.push({ id, model, choices: [], usage });
      return sse(res, chunks);
    }
    const callId = `call_${name}_${step}`;
    const chunks = [];
    if (r.pre) chunks.push({ id, model, choices: [{ index: 0, delta: { role: "assistant", content: r.pre }, finish_reason: null }] });
    chunks.push({ id, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: r.name, arguments: "" } }] }, finish_reason: null }] });
    chunks.push({ id, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(r.args) } }] }, finish_reason: null }] });
    chunks.push({ id, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    chunks.push({ id, model, choices: [], usage });
    return sse(res, chunks);
  });
}).listen(PORT, "127.0.0.1", () => console.error(`stub on ${PORT}`));
