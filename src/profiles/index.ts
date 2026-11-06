// Agent profiles (ADR-015 §6, ADR-024): the flat v1 spec every profile pins (./v1.ts), the v2 manifest (./v2.ts), the
// layers a name is looked up in and resolved through (./load.ts), a profile's skills (./skills.ts), resolution, pins
// and overrides (./resolve.ts), what `capcomd profiles`, GET /v1/profiles and a planner say of each (./describe.ts),
// the rows a client edits (./fields.ts) and the writes (./write.ts).
export * from "./v1";
export * from "./v2";
export * from "./load";
export * from "./skills";
export * from "./resolve";
export * from "./describe";
export * from "./fields";
export * from "./write";
