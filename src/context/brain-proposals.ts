// A run's proposals to a company's brain (ADR-025 step 5): what its consolidator proposed for the brain its profile
// names (a delta with `brain: <name>`, checked by ./consolidate.ts `brainDeltas` when the kernel stages its answer),
// kept by the kernel in kv `_context/brain/<agentId>.<n>` (reserved: only the kernel writes it), and sent to the brain
// through its provider's `propose` (groundray: a draft on the run's proposal branch of the brain's repository and a pull
// request there, ./groundray-write.ts). Each is sent once: the record keeps what came back.
//
// Who sends them follows the consolidator's profile's `context.review`, as for the project's memory (ADR-025 §5.3):
//  - `human` (the default): a person, with `capcomd context brain propose --run <runId> --yes` or a client's
//    `POST /v1/runs/{runId}/brain-proposals/send` (capability context.brain_proposals), who is then the proposal's actor
//    in the brain (`human:<id>`, ADR-025 §7: the approver forwarded, never an agent's claim);
//  - `lint`: the kernel, as the consolidator's staging ends (src/primitives/ops.ts), as `capcomd/<version>`.
// Either way a brain's owners review the pull request; a draft never raises authority there. Each one a person sent is
// told to the listener in this process (`onBrainProposed`: the context plugin, which records
// `plugin.context.brain_proposed`).
import type { ContextProvider, Provenance } from "../../packages/plugin/src/context-layer";
import type { Principal } from "../../packages/plugin/src/shapes";
import { RelayError } from "../core/errors";
import type { BrainDelta } from "./consolidate";
import { actorOf } from "./groundray-write";

/** Where a run keeps its brain proposals: `_context/brain/<agentId>.<n>`, one record each. */
export const BRAIN_KV = "_context/brain/";

/** One proposal to a brain, as the kernel keeps it. */
export interface BrainProposal extends BrainDelta {
  /** `<agentId>.<n>`: the consolidator and the delta's place in its answer. */
  id: string;
  /** The consolidator, from the kernel's records. */
  origin: NonNullable<Provenance["origin"]>;
  at: string;
  /** Once sent: as whom (groundray's actor), when, the item and where it is (the pull request). */
  sent: { actor: string; at: string; item: string; where: string } | null;
  /** Why the last send failed, while it isn't sent. */
  error?: string;
}

const kv = () => import("../primitives/state");

/** One proposal as the CLI and the API show it: never its text (an agent's, which a client renders as nothing more). */
export const proposalView = (p: BrainProposal) => ({
  id: p.id, agentId: p.origin.agentId, brain: p.brain, type: p.type, title: p.title, from: p.from, at: p.at, sent: p.sent, ...(p.error ? { error: p.error } : {}),
});

/** One proposal a person just sent to its brain, as the listener hears it: the run, what came back and as whom
 *  (groundray's actor, `human:<id>`). */
export type BrainProposed = (runId: string, p: { id: string; agentId: string; brain: string; item: string; where: string }, actor: string) => unknown;
let listener: BrainProposed | null = null;
/**
 * Hear each proposal a person sends from this process (the context plugin, which records its event); the returned
 * function stops it. One listener: the latest (a process with two hosts records each send once). The kernel's own sends
 * (`review: lint`) aren't told: the consolidator's result records them (src/plugins/context.ts `staged`).
 */
export function onBrainProposed(f: BrainProposed): () => void {
  listener = f;
  return () => { if (listener === f) listener = null; };
}

/** Keep a consolidator's proposals, each once (a replayed staging keeps what the first wrote). */
export async function keepBrainProposals(runId: string, list: ReadonlyArray<BrainProposal>): Promise<void> {
  const { kvWrite } = await kv();
  for (const p of list) {
    try { await kvWrite(runId, { k: `${BRAIN_KV}${p.id}`, value: p, expect: 0, writer: "capcomd" }); } catch (e) {
      if (!(e instanceof RelayError && e.code === "conflict")) throw e;
    }
  }
}

/** The run's brain proposals (one consolidator's with `agentId`), in the order they were proposed, with their versions. */
export async function brainProposals(runId: string, o: { agentId?: string } = {}): Promise<Array<{ version: number; value: BrainProposal }>> {
  const { kvList } = await kv();
  const { entries } = await kvList(runId, BRAIN_KV);
  return (entries as Array<{ k: string; value?: unknown; version?: number; writer?: string | null }>)
    .filter((e) => e.writer === "capcomd" && e.value && typeof e.value === "object" && typeof (e.value as BrainProposal).brain === "string")
    .map((e) => ({ version: e.version ?? 0, value: e.value as BrainProposal }))
    .filter((e) => !o.agentId || e.value.origin.agentId === o.agentId)
    .sort((a, b) => (a.value.origin.agentId < b.value.origin.agentId ? -1 : a.value.origin.agentId > b.value.origin.agentId ? 1 : a.value.n - b.value.n));
}

/** Under `review: lint`, how long the kernel spends sending a consolidator's proposals as it stages them: well inside the
 *  settle step's 10 minutes (src/actors/agent-workflow.ts), whatever the brain's remote or groundray do. */
export const LINT_SEND_BUDGET_MS = 4 * 60_000;
/** A proposal isn't started with less time than this left (a clone, groundray twice, a push and a pull request). */
const MIN_SEND_MS = 15_000;

export interface SentProposal { id: string; brain: string; title: string; ok: boolean; already: boolean; item?: string; where?: string; error?: string }

/**
 * Send the run's proposals not sent yet (one consolidator's with `agentId`) to their brains as `by`, one after the
 * other, through the active `groundray` provider (this process's: the daemon's or the CLI's): resolved for the
 * consolidator's run and agent with its brain, then `propose`. A failure is kept on its record and the next one is
 * tried; a record someone else sent meanwhile is left as they sent it. `budgetMs`: how long they may take together; those
 * it leaves no time for stay as they are (not sent, no error), for the next send.
 */
export async function sendBrainProposals(runId: string, o: { by: Principal; agentId?: string; timeoutMs?: number; budgetMs?: number }): Promise<SentProposal[]> {
  const { contextProviders } = await import("./providers");
  const { seamCall } = await import("../plugins/forges");
  const { kvWrite } = await kv();
  // Asked of this process's plugins only when one is sent.
  let active: Promise<ContextProvider | undefined> | null = null;
  const groundray = () => (active ??= contextProviders().then((m) => m.get("groundray")?.provider));
  const until = o.budgetMs === undefined ? Infinity : Date.now() + o.budgetMs;
  const out: SentProposal[] = [];
  for (const { version, value: p } of await brainProposals(runId, o.agentId ? { agentId: o.agentId } : {})) {
    const said = { id: p.id, brain: p.brain, title: p.title };
    if (p.sent) { out.push({ ...said, ok: true, already: true, item: p.sent.item, where: p.sent.where }); continue; }
    const left = until - Date.now();
    if (left < MIN_SEND_MS) { out.push({ ...said, ok: false, already: false, error: "not sent yet: the time for sending them ran out" }); continue; }
    const c = seamCall(Math.min(o.timeoutMs ?? 300_000, left));
    let next: BrainProposal;
    try {
      const provider = await groundray();
      if (!provider) throw new Error("the groundray context provider isn't active in this process");
      const scope = { projectId: null, repo: null, ref: null, profile: { name: p.origin.profile, version: 1 }, runId, agentId: p.origin.agentId, layers: ["project" as const], settings: { brain: p.brain }, bundleRoot: null };
      const { handle } = await provider.resolve(scope, c);
      const r = await provider.propose(handle, { text: { text: p.text, untrusted: true, by: p.origin.agentId }, title: p.title, type: p.type, op: "add" }, o.by, c);
      next = { ...p, sent: { actor: actorOf(o.by), at: new Date().toISOString(), item: r.id, where: r.where } };
      delete next.error;
    } catch (e) {
      next = { ...p, error: String((e as Error)?.message ?? e).slice(0, 500) };
    } finally { c.done(); }
    try { await kvWrite(runId, { k: `${BRAIN_KV}${p.id}`, value: next, expect: version, writer: "capcomd" }); } catch (e) {
      if (!(e instanceof RelayError && e.code === "conflict")) throw e;
    }
    const told = listener, s = next.sent;
    if (told && s?.actor.startsWith("human:")) await Promise.resolve().then(() => told(runId, { id: p.id, agentId: p.origin.agentId, brain: p.brain, item: s.item, where: s.where }, s.actor)).catch(() => {});
    out.push(next.sent ? { ...said, ok: true, already: false, item: next.sent.item, where: next.sent.where } : { ...said, ok: false, already: false, error: next.error! });
  }
  return out;
}
