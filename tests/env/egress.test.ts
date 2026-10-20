import { expect, test } from "bun:test";
import { egressFor, PROVIDER_EGRESS } from "../../src/agents/config";
import { egressHint } from "../../src/env/doctor";

test("provider+auth egress sets: codex subscription reaches the ChatGPT backend", () => {
  const sub = egressFor("codex", "subscription");
  for (const h of ["chatgpt.com", "auth.openai.com", "ab.chatgpt.com", "api.openai.com", "github.com"]) expect(sub).toContain(h);
  expect(egressFor("codex", "apikey")).not.toContain("chatgpt.com");
  expect(egressFor("claude-code", "apikey")).toEqual(["github.com", "api.anthropic.com", "registry.npmjs.org", "nodejs.org"]);
  expect(PROVIDER_EGRESS["claude-code"].subscription).toContain("api.anthropic.com");
  expect(new Set(sub).size).toBe(sub.length);
});

test("doctor egress hints name the blocked host", () => {
  const allow = egressFor("codex", "apikey");
  const live = "verify failed (exit 1): error sending request for url (https://chatgpt.com/backend-api/codex/models?client_version=0.47.0) failed to refresh available models";
  expect(egressHint(live, allow, "codex", "subscription")).toContain("egress denied: chatgpt.com is not on the VM allowlist");
  expect(egressHint("curl: (6) Could not resolve host: api.openai.com", allow, "codex", "apikey")).toContain("on the egress allowlist");
  expect(egressHint("failed to refresh models", allow, "codex", "subscription")).toContain("network/egress block");
  expect(egressHint("HTTP 401 (key rejected or not substituted)", allow, "codex", "apikey")).toBeUndefined();
  // the fixed allowlist covers the live failure host
  expect(egressHint(live, egressFor("codex", "subscription"), "codex", "subscription")).toContain("although it is on the egress allowlist");
});
