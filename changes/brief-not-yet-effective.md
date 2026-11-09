# CHANGELOG

- Fixed: a fact that isn't in effect yet no longer reaches agents' context brief as if it applied today. A brain (or
  the project's memory) item whose `valid_from` is a later date, such as a price change decided now for next March,
  used to be listed as a current `stable` fact next to the rule still in force. It is now left out until its day, and
  the brief's header says how many lines were left out that way ("1 line not in effect yet left out"). The file is
  still in the agent's copy of the brain. `capcomd context brief --json` and the `plugin.context.loaded` event include
  the count as `notYetEffective`.

# Spec

A fact not in effect yet leaves the brief (§6.6.7, the context router; ADR-025 §13 "Made in the final live checks"; found in a live groundray run): `IndexLine.authority` gains optional `validFrom` (additive, on its `Pick` of `Authority`; the built-in `memory` and `groundray` providers fill it from an item's `valid_from`), and the router leaves out a line whose `validFrom` is after the brief's UTC day, as it does a stale one, counting it in the header ("N lines not in effect yet left out"); it is back on its day, and until then it supersedes nothing (the line it replaces stays). The brief's result and `plugin.context.loaded` carry `notYetEffective` (additive), as `capcomd context brief --json` does. Before, a future-dated policy was briefed as a current `stable` line beside the one in force (groundray: such an item "must not be treated as currently applicable"). No hook, seam, route or config changes.
