// The reviewer's verdict and brief live with the reviewer gate (src/plugins/gate-reviewer/review.ts, plugin API §15.3).
// The kernel reads a review-mode agent's verdict from its result as it finishes (src/primitives/ops.ts), with this parser.
export { parseVerdict, reviewBrief, type Verdict } from "../plugins/gate-reviewer/review";
