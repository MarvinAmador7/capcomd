// What the built-in agent providers (agent-claude, agent-codex; docs/spec/plugin-api.md §7.3) share: reading a JSON
// line, a tool call's identity for the stuck watch, and how a runner error is classified. Plugin code only: it imports
// the plugin API, never the kernel.
import { redactJson, type ErrorClass } from "../../packages/plugin/src/seams";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";

/** One line of a CLI's JSON stream, redacted; null for a partial or non-object line. */
export function parseJson(line: string, redact: (s: string) => string): any | null {
  let raw: any;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  return redactJson(raw, redact);
}

/** A tool call's identity for the stuck watch (ADR-019 §2): the same name and input is the same call. */
export const toolCall = (name: unknown, input: unknown) => `${String(name)} ${JSON.stringify(input ?? {})}`.slice(0, 1000);
export const contentText = (c: unknown) =>
  (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "").slice(0, 1000);

/** §7.2.3 for an agent run: the runner's AgentError kinds (`src/agents/runner.ts`) as the kernel's classes. */
export function classifyAgentError(e: unknown, login: string): ErrorClass {
  const kind = e && typeof e === "object" && "kind" in e ? String((e as { kind: unknown }).kind) : "";
  if (kind === "credentials") return { kind: "auth", retryable: false, hint: login };
  if (kind === "cancelled") return { kind: "not_found", retryable: false };
  return { kind: "unknown", retryable: false };
}

/** A built-in agent provider's manifest (§4.1: built-ins carry the capcomd version and accept only it). */
export function agentManifest(name: string, seam: string, description: string): PluginManifest {
  return {
    schema: "capcomd.plugin/v1", name, version: VERSION, description, apiVersion: 1,
    engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: `./${name}.ts` },
    provides: [`seam:agent/${seam}`], contributes: { seams: [{ kind: "agent", name: seam }] },
  } as PluginManifest;
}
