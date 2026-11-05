// Spec §3: the package's harness.v1 mirrors are assignable from the kernel's zod schemas (src/api/contract.ts), so a
// contract change that breaks a hook payload fails typecheck here. Compile-time only; the one runtime test keeps bun
// from reporting an empty file.
import { expect, test } from "bun:test";
import type { z } from "zod";
import type { Agent as AgentSchema, AgentStatus as AgentStatusSchema, ApprovalKind as ApprovalKindSchema, ApprovalStatus as ApprovalStatusSchema, Decision as DecisionSchema, Run as RunSchema } from "../../../src/api/contract";
import type { HarnessEvent } from "../../../src/api/envelope";
import type { ClientScope } from "../../../src/api/clients";
import type { HarnessEventEnvelope } from "../src/context";
import type { PluginScope } from "../src/manifest";
import type { Agent, AgentStatus, ApprovalKind, ApprovalStatus, Decision, Run } from "../src/shapes";

type Assignable<From, To> = From extends To ? true : never;

// Each `true` fails to compile when the contract stops satisfying the mirror.
const _run: Assignable<z.infer<typeof RunSchema>, Run> = true;
const _agent: Assignable<z.infer<typeof AgentSchema>, Agent> = true;
const _agentStatus: Assignable<z.infer<typeof AgentStatusSchema>, AgentStatus> = true;
const _approvalKind: Assignable<z.infer<typeof ApprovalKindSchema>, ApprovalKind> = true;
const _approvalStatus: Assignable<z.infer<typeof ApprovalStatusSchema>, ApprovalStatus> = true;
const _decision: Assignable<z.infer<typeof DecisionSchema>, Decision> = true;
const _envelope: Assignable<HarnessEvent, HarnessEventEnvelope> = true;
// A plugin's scopes are a subset of the client scopes, and never `approve`.
const _scopes: Assignable<PluginScope, Exclude<ClientScope, "approve">> = true;

test("harness.v1 mirrors compile", () => {
  expect([_run, _agent, _agentStatus, _approvalKind, _approvalStatus, _decision, _envelope, _scopes].every(Boolean)).toBe(true);
});
