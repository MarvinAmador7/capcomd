// The context layer's contribution (ADR-025 §3, spec §4.7): the item envelope the built-in memory provider, a fact
// provider and any later one share, and the eight methods a provider implements. A profile names a list of providers
// (`context.providers`) and the kernel's router composes them into the brief at `agent.preparing` (§6.1 there): the
// router owns the budget, truncation, the header, fencing, supersession and freshness, so a provider only answers.
// (ADR-025 names this file context.ts; that is the plugin's own context, `PluginContext`, so the layer lives here.)
import type { ErrorClass, SeamCall } from "./seams";
import type { Principal, Untrusted } from "./shapes";

/** Authority classes the router branches on. `type` below is the provider's open vocabulary (groundray: decision,
 *  procedure, policy, …; memory: lesson, feedback, reference, …); procedures are skills and working notes are `kv`. */
export type ContextKind = "fact" | "memory";
export const CONTEXT_KINDS: readonly ContextKind[] = ["fact", "memory"];

/** Layers, innermost first: an ordered list the kernel owns (ADR-025 §4). v1 has two; a layer is added by amending §4. */
export type ContextLayer = "run" | "project";
export const CONTEXT_LAYERS: readonly ContextLayer[] = ["run", "project"];

/** Built by the kernel from the run and agent records, never by a plugin or from `contract` (ADR-025 §8). */
export interface ContextScope {
  projectId: string | null;
  /** The run's repository (its URL, as the run recorded it); null for a run without one. */
  repo: string | null;
  /** The branch the agent's checkout starts from (the run's target), whose tree the project layer is read at; null
   *  without a repository. */
  ref: string | null;
  profile: { name: string; version: number };
  runId: string | null;
  agentId: string | null;
  /** From the pinned spec's `context.providers[].layers`. */
  layers: readonly ContextLayer[];
  /** The provider's own settings from the same entry (everything but `name` and `layers`: groundray's `brain`), as the
   *  agent's pinned spec has them. */
  settings?: Readonly<Record<string, unknown>>;
  /** Where the kernel places a provider's bundle in the agent's sandbox (`<bundleRoot>/<provider>/<bundle.name>`, ADR-025
   *  §6.2): the same for every agent of a run, so a line's `path` can name a file there. Null: nothing is placed. */
  bundleRoot?: string | null;
}

/** A repository at a commit the kernel places, read-only by convention, in the agent's sandbox at
 *  `<scope.bundleRoot>/<provider>/<name>` before the agent starts (ADR-025 §6.2): a brain beside the checkout. The host
 *  fetches it (its URL, never a credential in it), the sandbox gets its tree, no history. */
export interface ContextBundle {
  /** The repository's URL or path, as the host fetches it. */
  remote: string;
  /** A branch that has the commit (fetched when the host's copy doesn't), or null. */
  branch: string | null;
  /** The commit, full hex: what the brief's lines and citations name. */
  commit: string;
  /** Its directory under the provider's, `^[a-z0-9][a-z0-9_-]{0,62}$`. */
  name: string;
}
/** The directory a provider's bundle `name` is placed at under `root` (ContextScope.bundleRoot). */
export const bundleDir = (root: string, provider: string, name: string): string => `${root.replace(/\/+$/, "")}/${provider}/${name}`;

/** `version`: a commit or a content hash. */
export interface ContextRef { provider: string; id: string; version: string }

export interface Provenance {
  method: "human-authored" | "imported" | "transformed" | "agent-generated" | "calculated";
  /** `human:<opaque-id>` (only the kernel, from an approval's Principal), `process:<id>`, or `capcomd/<version>`. */
  by: string;
  at: string;
  /** Kernel-stamped for agent output; `model` is what makes cross-generation transfer measurable. */
  origin?: { runId: string; agentId: string; profile: string; model: string | null; image: string | null };
  sources: readonly { id: string; resource: string; title?: string }[];
}
export interface Outcome { kind: "verify" | "merge"; id: string; sha?: string }
export interface Authority {
  status: "draft" | "stable" | "deprecated";
  /** Never from an agent principal. */
  verified: readonly { by: string; at: string }[];
  /** Absolute instants (OKF §5.5); a profile's `retain` is converted at write. */
  validFrom?: string;
  staleAfter?: string;
  supersedes?: readonly string[];
  supersededBy?: readonly string[];
  /** The gates that confirmed a memory: ids, resolved by lint. */
  outcomes?: readonly Outcome[];
  /** ACE counters, maintained by the consolidator. */
  helpful?: number;
  harmful?: number;
}

/** One line of the always-on index: what the brief shows. `paths` lets the model see which item applies to the file
 *  it is touching (no kernel code, works for every agent CLI). */
export interface IndexLine {
  ref: ContextRef;
  kind: ContextKind;
  type: string;
  /** At most `limits.descriptionChars` reach the brief, fenced. */
  description: Untrusted;
  /** Where the body is, as the agent sees it (a path in its checkout). */
  path: string;
  paths?: readonly string[];
  authority: Pick<Authority, "status" | "staleAfter" | "supersededBy">;
  modified: string;
}
export interface ContextItem {
  ref: ContextRef;
  kind: ContextKind;
  type: string;
  title: string;
  /** Always untrusted, verified or not. */
  text: Untrusted;
  path: string | null;
  layer: ContextLayer;
  /** null only for a fact bundle shared across projects. */
  scope: { projectId: string | null };
  provenance: Provenance;
  authority: Authority;
  confidence?: { level: "low" | "medium" | "high"; basis: string };
  /** `[Title — provider@version:path (id)]`, groundray's form. */
  citation: string;
}
export interface ContextHit { ref: ContextRef; score: number; title: string; description: Untrusted; kind: ContextKind; authority: IndexLine["authority"] }

/** What an agent or the consolidator may say. Everything else is stamped by the kernel. */
export interface ContextProposal {
  text: Untrusted;
  title?: string;
  type?: string;
  op?: "add" | "supersede" | "deprecate";
  target?: ContextRef;
}
/** `where`: a path on a branch, or a brain draft id. */
export interface ProposalReceipt { id: string; staged: true; where: string }

export interface ContextCaps {
  kinds: readonly ContextKind[];
  layers: readonly ContextLayer[];
  /** Accepts `propose`. */
  writable: boolean;
  /** Query features: "lexical", "filters", "asOf", … */
  search: readonly string[];
  /** Serves files the kernel can place in the sandbox (ADR-025 §6.2). */
  bundle: boolean;
}
export interface ContextDescriptor { name: string; descriptorVersion: 1; label: string; vendor: string; caps: ContextCaps; trainedFor?: string | null }

export interface ContextSearch { text: string; limit: number; kinds?: readonly ContextKind[]; status?: readonly Authority["status"][]; asOf?: string }

/** A context provider (`contributes.context`, `provides: context:<name>`). Every method takes a SeamCall and honours
 *  its signal; the router gives each provider 10 s and goes on without it, naming it in the brief's header. */
export interface ContextProvider {
  describe(): ContextDescriptor;
  available(c: SeamCall): Promise<{ ok: true } | { ok: false; reason: string; fix: string | null }>;
  classifyError(e: unknown): ErrorClass;
  /** Bind a scope to the provider's handle (a bundle path at a commit, a brain slug); refuses a scope it cannot isolate.
   *  A provider with `caps.bundle` names the one bundle the handle reads (placed for the agent when the brief holds it). */
  resolve(scope: ContextScope, c: SeamCall): Promise<{ handle: string; revision: string; bundle?: ContextBundle }>;
  /** Everything the brief needs, deterministic for `(handle, revision)`. */
  index(handle: string, c: SeamCall): Promise<{ revision: string; modified: string | null; lines: readonly IndexLine[] }>;
  search(handle: string, q: ContextSearch, c: SeamCall): Promise<ContextHit[]>;
  get(handle: string, ref: ContextRef, c: SeamCall): Promise<ContextItem>;
  /** Stage only: a file on a branch, a brain draft. Never publishes. `unsupported` unless `caps.writable`. */
  propose(handle: string, p: ContextProposal, by: Principal, c: SeamCall): Promise<ProposalReceipt>;
}

/** A provider a profile names (`context.providers[]`): its name, the layers it reads, and its own settings. */
export interface ContextProviderSpec { name: string; layers?: ContextLayer[]; [setting: string]: unknown }
/** ADR-025 §6.4: the router's budgets. null (or absent): the eval's default for the profile's model. */
export type ContextLimitName = "briefBytes" | "indexLines" | "descriptionChars" | "itemBytes" | "proposalsPerRun";
/** A profile's `context` block as it is pinned on an agent (ADR-025 §10; ADR-024's `memory` is read as one). */
export interface ContextSpec {
  providers?: ContextProviderSpec[];
  limits?: Partial<Record<ContextLimitName, number | null>>;
  review?: "human" | "lint";
}
