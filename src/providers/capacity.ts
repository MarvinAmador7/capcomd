// How many agents a local place runs at once. On Docker every agent's container shares one machine's memory (Docker
// Desktop's or OrbStack's VM), and memory, not disk, runs out first: one Claude Code process is 0.3-0.6 GB. So the cap
// is Docker's memory (`docker info` MemTotal) divided by a per-agent budget (1 GB by default). Above it, a new agent
// waits (it stays `pending`: its workflow isn't started) and starts when another finishes. The cloud (boxd) has no cap.
//
// The budget is a setting in the ADR-021 sense (Memory per agent, `agentMemory`: 512 MB, 1 GB, 2 GB or 4 GB in the
// apps): CAPCOMD_DOCKER_AGENT_MEMORY_MB in capcomd's environment wins, then the user config (`sandboxes.docker.agentMemory`,
// MB), then the default (src/providers/settings.ts `currentAgentMemory`). It is read each time an agent asks, never
// cached, so a change applies to the next agent that starts. Slots are counted in the engine's process: agents
// admitted here, plus capcomd agent containers Docker runs now (so agents that were running before a restart count).
import { dockerBin, DOCKER_LABEL } from "./docker";
import { AGENT_MEMORY_DEFAULT_MB, AGENT_MEMORY_ENV, AGENT_MEMORY_MIN_MB, currentAgentMemory, fileSettingsStore, settingsPath, type AgentMemory } from "./settings";

export { AGENT_MEMORY_DEFAULT_MB, AGENT_MEMORY_ENV, AGENT_MEMORY_MIN_MB, type AgentMemory };

type Env = Record<string, string | undefined>;
const MB = 1024 * 1024;

/** The per-agent memory budget on Docker: the environment variable, else the user config (at `configPath`), else 1 GB. */
export function agentMemory(env: Env = process.env, configPath: string | null = settingsPath(env)): AgentMemory {
  return currentAgentMemory("docker", { env, store: fileSettingsStore(configPath) });
}

/** Agents that fit at once: the memory over the budget, rounded down, and never fewer than one. */
export function agentSlots(memTotalBytes: number, perAgentMb: number): number {
  return Math.max(1, Math.floor(memTotalBytes / (perAgentMb * MB)));
}

/** Whether an agent may start: the slots in use plus the agents that asked before it still leave one free. */
export function admits(o: { slots: number; used: number; ahead: number }): boolean {
  return o.used + o.ahead < o.slots;
}

/** "7.8 GB". */
export const gb = (bytes: number) => `${(bytes / (1024 * MB)).toFixed(1).replace(/\.0$/, "")} GB`;

export interface SlotRequest { admitted: boolean; slots: number | null; used: number; ahead: number; memTotal: number | null; perAgentMb: number }

/**
 * The slots of one place, in the engine's process. `request(name, since)`: may the agent whose machine will be `name`
 * start now? Agents are admitted oldest request first; an admitted agent holds its slot until `release(name)` (its
 * machine is destroyed, or its workflow ended: src/actors/agent-workflow.ts `freeSlot`), or, if its machine never shows
 * up among the running ones, for `graceMs`: a backstop for an agent still starting (its machine's start being retried).
 */
export class AgentSlots {
  private admitted = new Map<string, number>();
  private waiting = new Map<string, { since: number; seen: number }>();
  constructor(private readonly o: {
    memTotal: () => Promise<number | null>;
    /** Names of capcomd's agent machines running now. */
    running: () => Promise<string[]>;
    perAgentMb: () => number;
    now?: () => number;
    /** How long an admitted agent holds its slot before its machine is running (default 10 minutes). */
    graceMs?: number;
    /** A waiting agent that stopped asking for this long is no longer ahead of anyone (default 1 minute). */
    staleMs?: number;
  }) {}

  async request(name: string, since: number): Promise<SlotRequest> {
    const now = (this.o.now ?? Date.now)();
    const perAgentMb = this.o.perAgentMb();
    const [memTotal, running] = await Promise.all([this.o.memTotal().catch(() => null), this.o.running().catch(() => null)]);
    // Docker didn't say (it's down, or slow): don't hold agents back on a probe; starting them reports the real problem.
    if (memTotal === null || running === null) { this.admitted.set(name, now); this.waiting.delete(name); return { admitted: true, slots: null, used: 0, ahead: 0, memTotal, perAgentMb }; }
    const live = new Set(running);
    for (const [n, at] of this.admitted) if (!live.has(n) && now - at > (this.o.graceMs ?? 10 * 60_000)) this.admitted.delete(n);
    for (const [n, w] of this.waiting) if (now - w.seen > (this.o.staleMs ?? 60_000)) this.waiting.delete(n);
    const slots = agentSlots(memTotal, perAgentMb);
    // Already holding a slot (asked again, or running since before a restart).
    if (this.admitted.has(name) || live.has(name)) { this.admitted.set(name, this.admitted.get(name) ?? now); this.waiting.delete(name); return { admitted: true, slots, used: new Set([...this.admitted.keys(), ...live]).size, ahead: 0, memTotal, perAgentMb }; }
    const used = new Set([...this.admitted.keys(), ...live]).size;
    this.waiting.set(name, { since, seen: now });
    const ahead = [...this.waiting].filter(([n, w]) => n !== name && (w.since < since || (w.since === since && n < name))).length;
    if (!admits({ slots, used, ahead })) return { admitted: false, slots, used, ahead, memTotal, perAgentMb };
    this.waiting.delete(name);
    this.admitted.set(name, now);
    return { admitted: true, slots, used: used + 1, ahead, memTotal, perAgentMb };
  }

  release(name: string): void {
    this.admitted.delete(name);
    this.waiting.delete(name);
  }

  /** Whether `name` holds a slot here now (admitted, not yet released): tests and the release on a workflow's end. */
  holds(name: string): boolean { return this.admitted.has(name); }
}

/** Runs the docker CLI for a short answer (3 s), or null when it doesn't give one. */
async function dockerOut(args: string[], env: Env): Promise<string | null> {
  let p: ReturnType<typeof Bun.spawn>;
  try { p = Bun.spawn([dockerBin(env), ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: env as Record<string, string> }); } catch { return null; }
  const timer = setTimeout(() => p.kill(), 3_000);
  const [out, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited]).finally(() => clearTimeout(timer));
  return code === 0 ? out : null;
}

const cached = <T>(ttlMs: number, ask: () => Promise<T>) => {
  let last: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (!last || Date.now() - last.at > ttlMs) last = { at: Date.now(), value: ask() };
    return last.value;
  };
};

/** Docker's memory (`docker info` MemTotal, bytes), asked at most every 5 minutes; null when Docker doesn't answer. */
export const dockerMemTotal = cached(5 * 60_000, async () => {
  const out = await dockerOut(["info", "--format", "{{.MemTotal}}"], process.env);
  const n = Number(out?.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
});

/** capcomd's agent containers running now (an agent's carry its worker's id as a label), asked at most every 2 s. */
const dockerAgentsRunning = cached(2_000, async () => {
  const out = await dockerOut(["ps", "--filter", `label=${DOCKER_LABEL}=1`, "--filter", "label=workerId", "--filter", "status=running", "--format", "{{.Names}}"], process.env);
  if (out === null) throw new Error("docker ps failed");
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
});

/** The places with a memory cap, by name: only Docker (its agents share this machine's memory). */
const PLACES: Record<string, () => AgentSlots> = {};
let docker: AgentSlots | null = null;
PLACES.docker = () => (docker ??= new AgentSlots({ memTotal: dockerMemTotal, running: dockerAgentsRunning, perAgentMb: () => agentMemory().mb }));

// Test knob: CAPCOMD_FAKE_MEMORY_MB gives the test fakes a cap of that much memory (none of their machines runs in
// Docker, so only the agents admitted here hold slots).
let fakes: { mb: number; slots: AgentSlots } | null = null;
function fakeSlots(): AgentSlots | null {
  const mb = Number(process.env.CAPCOMD_FAKE_MEMORY_MB);
  if (!Number.isFinite(mb) || mb <= 0) return null;
  if (fakes?.mb !== mb) fakes = { mb, slots: new AgentSlots({ memTotal: async () => mb * MB, running: async () => [], perAgentMb: () => agentMemory().mb }) };
  return fakes.slots;
}

/**
 * An agent's machine will never be (or is no longer) asked for: free its slot on every place that has one. Safe at any
 * time after the agent's workflow ended: a container that still runs is counted from `docker ps` anyway, so only an
 * admitted agent whose container never appeared (its start failed, it was cancelled or paused first) gets its slot
 * back sooner than the grace period.
 */
export function releaseSlot(name: string): void {
  docker?.release(name);
  fakes?.slots.release(name);
}

/** The slots of a place, or null when it has no cap (the cloud, the test fakes). */
export function slotsFor(place: string | null | undefined): AgentSlots | null {
  if (place === "fake" || place === "fake-host") return fakeSlots();
  return place && Object.hasOwn(PLACES, place) ? PLACES[place]!() : null;
}

/** What the place's info row needs from Docker: its memory (the budget is the setting's, read with the row), or null
 *  when the place has no cap. */
export async function slotsInfo(place: string): Promise<{ memTotal: number | null } | null> {
  if (!Object.hasOwn(PLACES, place)) return null;
  return { memTotal: await dockerMemTotal().catch(() => null) };
}
