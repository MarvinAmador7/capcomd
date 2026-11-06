// Agent profiles (ADR-015 §6, ADR-024): the flat v1 spec every profile pins (./v1.ts), the v2 manifest (./v2.ts), the
// layers a name is looked up in and resolved through (./load.ts), resolution, pins and overrides (./resolve.ts), and
// what a planner reads to choose one (./describe.ts).
export * from "./v1";
export * from "./v2";
export * from "./load";
export * from "./resolve";
export * from "./describe";
