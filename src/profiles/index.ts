// Agent profiles (ADR-015 §6, ADR-024): the flat v1 spec every profile pins (./v1.ts), the v2 manifest (./v2.ts), the
// layers a name is looked up in and resolved through (./load.ts), a profile's skills (./skills.ts), resolution, pins
// and overrides (./resolve.ts), and what `capcomd profiles`, GET /v1/profiles and a planner say of each (./describe.ts).
export * from "./v1";
export * from "./v2";
export * from "./load";
export * from "./skills";
export * from "./resolve";
export * from "./describe";
