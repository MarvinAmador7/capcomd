// Promotion is a merge (ADR-025 §5.3, step 3): what the `context-memory` plugin's gates judge of a branch that changes
// the project's memory (`.capcomd/context/`), at verify (`verify.judging`: lint as a check) and at merge
// (`merge.landing`: deny, hold or let it land). Pure over what the plugin read (src/plugins/context-memory.ts):
//  - a branch that changes nothing under `.capcomd/context/` isn't judged;
//  - memory lands only from a consolidator (an agent of the `context-consolidator` profile) or a person: any other
//    agent's branch that changes it is refused, whoever asks for the merge;
//  - a consolidator's branch changes nothing outside `.capcomd/context/`;
//  - and passes `capcomd context lint` against the commit it left its target from: items only, frontmatter, ids
//    unique and never changed or deleted, supersession reciprocal and acyclic, no secret, every outcome of a changed
//    item a passed verify or a landed merge of the run, index.md as lint writes it. Lint's warnings (an item that reads
//    like an instruction, a stale or large one) don't fail it: they go to the person in the hold's reason.
// `review` is the consolidator's profile's `context.review`: `human` (the default, D5) holds the merge for a person,
// `lint` lets a green lint land it alone.
import type { Outcome } from "../../packages/plugin/src/context-layer";
import { CONSOLIDATOR_PROFILE } from "./consolidate";
import { lintContext, type LintFile, type LintProblem } from "./lint";
import { CONTEXT_DIR } from "./memory";
import type { ScanHit } from "./scan";

export type Review = "human" | "lint";

/** What the gates read of a branch. */
export interface BranchFacts {
  /** The agent whose work it is; null for a branch that isn't an agent's (a person's). */
  agent: { id: string; profile: string | null; review: Review } | null;
  /** What it changes, from the commit it left its target at. */
  files: ReadonlyArray<{ path: string; oldPath?: string | null }>;
  /** `.capcomd/context/` at its commit, and at the commit it left its target at. */
  after: LintFile[];
  before: LintFile[];
}

export interface Judgement {
  /** Whether it changes `.capcomd/context/` at all (nothing else is judged when it doesn't). */
  touches: boolean;
  consolidator: boolean;
  review: Review;
  /** Why it can't land: each one sentence, naming the file. Empty when it may. */
  problems: string[];
  /** What a person should look at (lint's warnings), each naming the file. */
  warnings: string[];
  /** The memory files it changes. */
  changed: string[];
}

/** A path as a checkout on a case-insensitive file system reads it (macOS's and Windows' default): `.Capcomd/Context/x.md`
 *  lands in `.capcomd/context/` there. Also without what HFS+ ignores in a name (git's own list for `.git`), nor the dots
 *  and spaces Windows drops from a name's end. */
const asCheckedOut = (p: string) => p.normalize("NFC").replace(/[‌-‏‪-‮⁪-⁯﻿]/g, "").split("/").map((s) => s.replace(/[. ]+$/, "")).join("/").toLowerCase();

/** Whether a changed path is the project's memory: a file under `.capcomd/context/`, or the directory itself or
 *  `.capcomd` made a file (a link: what an agent's checkout then reads as memory is wherever it points), by any name a
 *  checkout may read as one of those (`.Capcomd/Context/…`). */
export const touchesContext = (p: string | null | undefined): boolean => {
  if (!p) return false;
  const q = asCheckedOut(p);
  return q.startsWith(CONTEXT_DIR) || CONTEXT_DIR.startsWith(`${q}/`);
};
const under = touchesContext;
const said = (ps: LintProblem[]) => ps.map((p) => `${p.file}: ${p.message}`);
const listed = (xs: string[], max = 5) => `${xs.slice(0, max).join(", ")}${xs.length > max ? ` and ${xs.length - max} more` : ""}`;

/** The text a merge.landing deny gives for an agent that isn't a consolidator (ADR-025 §5.3's words). */
export const NOT_A_CONSOLIDATOR = "memory lands only from a consolidator or a person";

export function judgeBranch(f: BranchFacts, o: { scan: (t: string) => ScanHit | null; outcome: ((x: Outcome) => boolean) | null; itemBytes: number | null; descriptionChars: number | null; now?: number }): Judgement {
  const changed = [...new Set(f.files.flatMap((x) => [x.path, x.oldPath ?? null]).filter(under))] as string[];
  const out: Judgement = { touches: changed.length > 0, consolidator: f.agent?.profile === CONSOLIDATOR_PROFILE, review: f.agent?.review ?? "human", problems: [], warnings: [], changed };
  if (!out.touches || !f.agent) return out;
  if (!out.consolidator) {
    out.problems.push(`${NOT_A_CONSOLIDATOR}: ${f.agent.id} (${f.agent.profile ? `profile ${f.agent.profile}` : "no profile"}) changed ${listed(changed)}. Propose a lesson in the agent's result instead (capcomd result --data '{"context": [...]}'), and the run's consolidator stages it.`);
    return out;
  }
  const outside = [...new Set(f.files.flatMap((x) => [x.path, x.oldPath ?? null]).filter((p): p is string => !!p && !under(p)))];
  if (outside.length) out.problems.push(`a consolidator's branch changes only ${CONTEXT_DIR}: ${f.agent.id} also changed ${listed(outside)}`);
  const replaced = changed.filter((p) => !p.startsWith(CONTEXT_DIR));
  if (replaced.length) out.problems.push(`a consolidator's branch changes the items in ${CONTEXT_DIR} by that exact name, never the directory itself or a name a checkout reads as it: ${f.agent.id} changed ${listed(replaced)}`);
  const r =lintContext({ files: f.after, base: f.before, scan: o.scan, outcome: o.outcome, itemBytes: o.itemBytes, descriptionChars: o.descriptionChars, ...(o.now !== undefined ? { now: o.now } : {}) });
  out.problems.push(...said(r.errors).map((x) => `context lint: ${x}`));
  out.warnings.push(...said(r.warnings));
  return out;
}

/** The hold's reason for a consolidator's branch under `review: human`: what changes, and what lint flagged for the
 *  person. Its `holdId` names the commit, so an approval holds for that commit only. */
export function holdOf(j: Judgement, commit: string): { reason: string; holdId: string } {
  const items = j.changed.filter((p) => !p.endsWith("/index.md")).map((p) => p.slice(CONTEXT_DIR.length));
  const flags = j.warnings.length ? ` Lint flags ${j.warnings.length}: ${listed(j.warnings.map((w) => w.slice(CONTEXT_DIR.length)), 3)}.` : "";
  return {
    reason: `the project's memory changes only after a person reads it (review: human): ${items.length} item${items.length === 1 ? "" : "s"} (${listed(items)}).${flags}`.slice(0, 1000),
    holdId: `memory@${commit.slice(0, 12)}`,
  };
}
