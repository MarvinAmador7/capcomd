// The out-of-process runtime (spec §9): one plugin's child process and its sessions. The kernel's launcher starts the
// process with a filtered environment and a token minted for that start (§9.2, §9.3); the process opens its session
// (`open`), then the hooks stream (`attach`), and answers gate and modify calls (`answer`). This side keeps the frames:
// observe calls queue while no stream is open (1 000 frames or 4 MB, the oldest dropped and counted, §9.5); gate and
// modify calls go one at a time, the next after the previous is answered or its deadline passed (§9.4); a stream closed
// for 60 s makes the plugin disconnected; a process that exits is started again with a new session and token, with
// backoff, until five exits in ten minutes fail it (`restart_limit`). A gate call in flight when the process exits is
// `crashed`, so it denies (§6.5). Transport-agnostic: the kernel's gateway (src/api/server.ts) maps HTTP onto it.
import { randomBytes } from "node:crypto";
import { HookFailure, type HookFailureKind, type PluginFailureCause } from "../errors";
import { HOOKS, type HookCall, type HookName } from "../hooks";
import type { PluginManifest } from "../manifest";
import { PLUGIN_PROTOCOL_VERSION, type HookFrame, type SessionOpen, type SessionOpened, type WireHookCall } from "../protocol";
import type { HostEvent } from "./registry";

/** One start of a plugin's process, as the kernel's launcher made it. */
export interface ProcessStart {
  /** The client the launcher minted for this start: only a request with its token belongs to this start. */
  clientId: string;
  pid: number | null;
  /** Settles when the process has exited (or could not be started). */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Signal the process and what it started (its process group). */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Revoke the start's token; the host calls it once the process is gone. */
  revoke(): void;
}

/** How the kernel starts a plugin's process (§9.2, §9.3): the command, the environment, the token. */
export interface ProcessLauncher {
  start(o: { manifest: PluginManifest; root: string; dataDir: string; session: string }): ProcessStart;
  /** Called right after a gate or modify call went out to the process: the kernel's chaos killpoints. */
  sent?(plugin: string, start: ProcessStart): void;
}

/** A refused protocol request, with the HTTP status the gateway answers (§9.3, §9.4). */
export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
  constructor(readonly status: 403 | 404 | 409 | 422, readonly code: "forbidden" | "not_found" | "conflict" | "invalid", message: string) {
    super(message);
  }
}

/** Who sent a protocol request: the authenticated client, and the plugin its token was minted for. */
export interface ProtocolCaller { clientId: string; plugin?: string | null }

/** Where a hooks stream's frames go (the gateway's SSE response). */
export interface FrameSink { frame(f: HookFrame): void; close(): void }

/** The deadlines and limits of §9.3 and §9.5; tests shorten them. */
export interface ProcessTimings {
  /** The session must be open and the hooks stream attached within this (§9.3). Default 30 s. */
  connectWithinMs?: number;
  /** A hooks stream closed this long makes the plugin disconnected (§9.5). Default 60 s. */
  disconnectMs?: number;
  /** The wait before the n-th restart (1, 2, 3 …). Default 1 s, 2 s, 4 s … 60 s. */
  backoffMs?(n: number): number;
  /** Exits within `restartWindowMs` that fail the plugin with `restart_limit`. Default 5 in 10 minutes. */
  restartLimit?: number;
  restartWindowMs?: number;
  /** On dispose: how long the process has after `session.closing`, then after SIGTERM (§9.7). Default 5 s each. */
  closingMs?: number;
  termMs?: number;
}

export interface ProcessOptions {
  name: string;
  manifest: PluginManifest;
  root: string;
  dataDir: string;
  /** sha256 of the manifest file the host loaded (§9.3: a process started from other files is refused). */
  manifestHash: string;
  launcher: ProcessLauncher;
  emit(e: HostEvent): void;
  /** What a session's handshake answers beside its id, protocol and deadline (§9.3). */
  opened(): Omit<SessionOpened, "session" | "protocol" | "connectWithinMs">;
  /** The first session opened: register the plugin's listeners. They stay through restarts, so a gate fired while the
   *  process is down is still asked (and fails closed) instead of passing unjudged. */
  listen(): void;
  /** The process can't be kept running: the host fails the plugin with this cause (§9.5). */
  failed(cause: PluginFailureCause, message: string): void;
  /** Observe calls dropped from a full queue (the registry's stats, §13.2). */
  dropped(n: number): void;
  /** The kernel's redactor, run on every frame before it reaches the process (§11.5). */
  redact?(v: unknown): unknown;
  timings?: ProcessTimings;
}

type Session = {
  id: string;
  start: ProcessStart;
  open: boolean;
  exited: boolean;
  seq: number;
  sink: FrameSink | null;
  /** Frames sent on this session, for a reconnect's Last-Event-ID (§9.4). */
  ring: Array<{ seq: number; frame: HookFrame }>;
  disconnected: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  ready: () => void;
  readyAt: Promise<void>;
};
type Gate = { call: WireHookCall; resolve(v: unknown): void; reject(e: unknown): void; sentIn: string | null; seq: number; cleanup(): void };
type Outgoing = { frame: "hook.call"; call: WireHookCall; bytes: number };

const RING = 1000;
const OUTBOX_FRAMES = 1000;
const OUTBOX_BYTES = 4 * 1024 * 1024;
const REMEMBERED = 1000;
const hex = (n: number) => randomBytes(n).toString("hex");
const sleep = (ms: number) => new Promise<"slept">((r) => { const t = setTimeout(() => r("slept"), ms); (t as { unref?: () => void }).unref?.(); });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A bounded set: the oldest entries go first. */
const remember = (s: Set<string>, id: string) => { s.add(id); if (s.size > REMEMBERED) s.delete(s.values().next().value!); };

export class ProcessPlugin {
  private session: Session | null = null;
  private active = false;
  private stopping = false;
  private listening = false;
  private exits: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly gates: Gate[] = [];
  private readonly outbox: Outgoing[] = [];
  private outboxBytes = 0;
  private readonly drops = { count: 0, hooks: new Set<HookName>() };
  /** Calls answered, or whose deadline passed: a later answer is 409 (§9.4). */
  private readonly closed = new Set<string>();
  /** Observe calls sent: an answer to one is taken (204) and ignored. */
  private readonly observed = new Set<string>();
  private readonly verdicts = new Map<string, (f: { kind: HookFailureKind; message: string } | null) => void>();
  private readonly t: Required<ProcessTimings>;

  constructor(private readonly o: ProcessOptions) {
    const t = o.timings ?? {};
    this.t = {
      connectWithinMs: t.connectWithinMs ?? 30_000, disconnectMs: t.disconnectMs ?? 60_000,
      backoffMs: t.backoffMs ?? ((n) => Math.min(60_000, 1000 * 2 ** (n - 1))),
      restartLimit: t.restartLimit ?? 5, restartWindowMs: t.restartWindowMs ?? 10 * 60_000,
      closingMs: t.closingMs ?? 5000, termMs: t.termMs ?? 5000,
    };
  }

  get pid(): number | null { return this.session && !this.session.exited ? this.session.start.pid : null; }

  /** `loading → active` (§5.4): the process started, opened its session and its hooks stream within `connectWithinMs`. */
  async run(): Promise<{ cause: "handshake_timeout" | "crashed"; message: string } | null> {
    const s = this.launch();
    const r = await this.until(s);
    if (r === "ready") { this.active = true; return null; }
    if (r === "timeout") {
      this.stopping = true;
      s.start.kill("SIGKILL");
      return { cause: "handshake_timeout", message: `the process did not open its session and hooks stream within ${this.t.connectWithinMs} ms (§9.3)` };
    }
    const x = await s.start.exited;
    return { cause: "crashed", message: `the process exited (${x.signal ?? `code ${x.code}`}) before its hooks stream was open` };
  }

  // ---- the hook listener -----------------------------------------------------------------------------------------

  /** A call to this plugin's listener for `call.hook`, as the registry makes it. Observe calls are queued and return at
   *  once; gate and modify calls resolve with the process's answer (the registry checks it and applies the deadline). */
  call(call: HookCall): Promise<unknown> | undefined {
    const wire = this.wire(call);
    if (HOOKS[call.hook].mode === "observe") {
      this.observe(wire);
      return undefined;
    }
    if (this.session?.disconnected) throw new HookFailure("disconnected", `the ${this.o.name} plugin's hooks stream has been closed for over ${Math.round(this.t.disconnectMs / 1000)} s`);
    return new Promise((resolve, reject) => {
      const expired = () => call.signal.reason ?? new HookFailure("timeout", "the call's deadline passed");
      if (call.signal.aborted) return reject(expired());
      const g: Gate = { call: wire, resolve, reject, sentIn: null, seq: 0, cleanup: () => {} };
      const onAbort = () => { this.settle(g); reject(expired()); };
      call.signal.addEventListener("abort", onAbort, { once: true });
      g.cleanup = () => call.signal.removeEventListener("abort", onAbort);
      this.gates.push(g);
      this.pump();
    });
  }

  /** The registry judged a call's answer (§6.2): the answer route's verdict waits for it. */
  settled(callId: string, failure: { kind: HookFailureKind; message: string } | null): void {
    this.verdicts.get(callId)?.(failure);
  }

  // ---- the protocol ----------------------------------------------------------------------------------------------

  /** POST …/sessions (§9.3). */
  open(caller: ProtocolCaller, body: unknown): SessionOpened {
    const s = this.own(caller);
    if (!isObject(body) || typeof body.session !== "string" || typeof body.manifestHash !== "string" || !Array.isArray(body.hooks) || typeof body.pid !== "number")
      throw new ProtocolError(422, "invalid", "body must be SessionOpen {session, protocol, manifestHash, pid, hooks}");
    const b = body as unknown as SessionOpen;
    if (b.session !== s.id) throw new ProtocolError(409, "conflict", "not the session the host issued for this start (CAPCOMD_PLUGIN_SESSION)");
    if (s.open) throw new ProtocolError(409, "conflict", "this session is already open");
    if (b.manifestHash !== this.o.manifestHash) throw new ProtocolError(409, "conflict", "manifestHash is not the loaded manifest's: the process was started from other files");
    if (b.protocol !== PLUGIN_PROTOCOL_VERSION) throw new ProtocolError(422, "invalid", `protocol ${JSON.stringify(b.protocol)} is not one this host speaks (${PLUGIN_PROTOCOL_VERSION})`);
    const declared = Object.keys(this.o.manifest.contributes?.hooks ?? {}).sort();
    const asked = [...new Set(b.hooks.map(String))].sort();
    if (asked.length !== b.hooks.length || asked.join("\n") !== declared.join("\n"))
      throw new ProtocolError(422, "invalid", `hooks must be exactly contributes.hooks (${declared.join(", ") || "none"})`);
    s.open = true;
    if (!this.listening) { this.listening = true; this.o.listen(); }
    return { session: s.id, protocol: PLUGIN_PROTOCOL_VERSION, connectWithinMs: this.t.connectWithinMs, ...this.o.opened() };
  }

  /** GET …/hooks (§9.4): the session's one stream; a second replaces the first. Returns the detach to call when the
   *  stream ends. `lastEventId` resumes: the frames after it are sent again (a gap past the buffer is a `hook.dropped`). */
  attach(caller: ProtocolCaller, session: string, lastEventId: number | null, sink: FrameSink): () => void {
    const s = this.own(caller);
    if (s.id !== session || !s.open) throw new ProtocolError(409, "conflict", s.id !== session ? "not this start's session" : "open the session first (POST …/sessions)");
    if (s.sink) {
      const old = s.sink;
      s.sink = null;
      old.frame({ frame: "session.closing", seq: ++s.seq, reason: "replaced" });
      old.close();
    }
    s.sink = sink;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (s.disconnected) {
      s.disconnected = false;
      this.changed("reconnected");
    }
    const head = this.gates[0];
    if (lastEventId !== null) {
      const oldest = s.ring[0]?.seq ?? s.seq + 1;
      const missed = Math.max(0, Math.min(s.seq, oldest - 1) - lastEventId);
      if (missed) sink.frame({ frame: "hook.dropped", seq: lastEventId, count: missed, hooks: [] });
      for (const e of s.ring) if (e.seq > lastEventId && (e.frame.frame !== "hook.call" || HOOKS[e.frame.call.hook].mode === "observe" || e.frame.call.callId === head?.call.callId)) sink.frame(e.frame);
    }
    // The open gate call again, same callId, when the process may not have seen it (§9.4 retries).
    if (head?.sentIn === s.id && (lastEventId === null || head.seq <= lastEventId)) sink.frame({ frame: "hook.call", seq: head.seq, call: head.call });
    s.ready();
    this.pump();
    return () => {
      if (s.sink !== sink) return;
      s.sink = null;
      if (s.exited || this.stopping) return;
      s.timer = setTimeout(() => this.disconnect(s), this.t.disconnectMs);
      (s.timer as { unref?: () => void }).unref?.();
    };
  }

  /** POST …/hooks/{callId} (§9.4): taken (resolves), or a ProtocolError (403, 404, 409, 422). */
  async answer(caller: ProtocolCaller, callId: string, body: unknown): Promise<void> {
    const s = this.own(caller);
    if (!isObject(body) || typeof body.session !== "string" || !("result" in body)) throw new ProtocolError(422, "invalid", "body must be HookAnswer {session, result}");
    if (body.session !== s.id) throw new ProtocolError(409, "conflict", "not this start's session");
    const g = this.gates.find((x) => x.call.callId === callId && x.sentIn === s.id);
    if (!g) {
      if (this.closed.has(callId)) throw new ProtocolError(409, "conflict", "this call was already answered, or its deadline passed (the host applied its failure policy)");
      if (this.observed.has(callId)) return;
      throw new ProtocolError(404, "not_found", `no call ${callId.slice(0, 64)} was sent to this session`);
    }
    const verdict = new Promise<{ kind: HookFailureKind; message: string } | null>((r) => this.verdicts.set(callId, r));
    this.settle(g);
    g.resolve(body.result);
    const f = await Promise.race([verdict, sleep(2000).then(() => null)]);
    this.verdicts.delete(callId);
    if (f?.kind === "invalid_result") throw new ProtocolError(422, "invalid", f.message);
  }

  /** §9.7, §5.3 step 5: `session.closing`, then 5 s for the process to exit, SIGTERM, 5 s more, SIGKILL; the token is
   *  revoked once it is gone. With no stream open the process can't hear `session.closing`: SIGTERM at once. Calls still
   *  open fail (`disconnected`). */
  async dispose(reason: "daemon_stopping" | "disabled" | "replaced"): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const s = this.session;
    if (s && !s.exited) {
      const gone = s.start.exited.then(() => "gone" as const);
      const told = !!s.sink;
      if (told) this.send(s, { frame: "session.closing", reason });
      if (!told || (await Promise.race([gone, sleep(this.t.closingMs)])) !== "gone") {
        s.start.kill("SIGTERM");
        if ((await Promise.race([gone, sleep(this.t.termMs)])) !== "gone") {
          s.start.kill("SIGKILL");
          await Promise.race([gone, sleep(2000)]);
        }
      }
    }
    if (s) this.end(s);
    for (const g of [...this.gates]) { this.settle(g); g.reject(new HookFailure("disconnected", `the ${this.o.name} plugin stopped`)); }
  }

  // ---- sessions --------------------------------------------------------------------------------------------------

  private launch(): Session {
    let ready!: () => void;
    const readyAt = new Promise<void>((r) => { ready = r; });
    const id = `ses_${hex(12)}`;
    const start = this.o.launcher.start({ manifest: this.o.manifest, root: this.o.root, dataDir: this.o.dataDir, session: id });
    const s: Session = { id, start, open: false, exited: false, seq: 0, sink: null, ring: [], disconnected: false, timer: null, ready, readyAt };
    this.session = s;
    this.changed("started");
    void start.exited.then((x) => this.exited(s, x));
    return s;
  }

  /** The session is ready (open, with its stream attached), its process exited, or `connectWithinMs` passed. */
  private async until(s: Session): Promise<"ready" | "exited" | "timeout"> {
    return Promise.race([s.readyAt.then(() => "ready" as const), s.start.exited.then(() => "exited" as const), sleep(this.t.connectWithinMs).then(() => "timeout" as const)]);
  }

  private exited(s: Session, x: { code: number | null; signal: string | null }) {
    if (s.exited) return;
    s.exited = true;
    this.end(s);
    if (this.session !== s) return;
    // A gate call in flight is crashed (§9.5): the registry denies it. Calls not yet sent wait for the next start.
    const head = this.gates[0];
    if (head?.sentIn === s.id) { this.settle(head); head.reject(new HookFailure("crashed", `the ${this.o.name} plugin's process exited (${x.signal ?? `code ${x.code}`}) with the call in flight`)); }
    this.changed("exited", s.start.pid, x.code);
    if (this.stopping || !this.active) return;
    const now = Date.now();
    this.exits = [...this.exits.filter((t) => now - t < this.t.restartWindowMs), now];
    if (this.exits.length >= this.t.restartLimit) {
      this.stopping = true;
      for (const g of [...this.gates]) { this.settle(g); g.reject(new HookFailure("crashed", `the ${this.o.name} plugin's process keeps exiting`)); }
      this.o.failed("restart_limit", `the process exited ${this.exits.length} times within ${Math.round(this.t.restartWindowMs / 60_000)} minutes (§9.5)`);
      return;
    }
    this.changed("restarting");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      const next = this.launch();
      // A start that never connects is killed: its exit counts like any other.
      void this.until(next).then((r) => { if (r === "timeout" && !next.exited) next.start.kill("SIGKILL"); });
    }, this.t.backoffMs(this.exits.length));
    (this.restartTimer as { unref?: () => void }).unref?.();
  }

  private end(s: Session) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    const sink = s.sink;
    s.sink = null;
    sink?.close();
    s.start.revoke();
  }

  private disconnect(s: Session) {
    s.timer = null;
    if (s.sink || s.exited || this.session !== s || this.stopping) return;
    s.disconnected = true;
    this.changed("disconnected");
    for (const g of [...this.gates]) { this.settle(g); g.reject(new HookFailure("disconnected", `the ${this.o.name} plugin's hooks stream has been closed for over ${Math.round(this.t.disconnectMs / 1000)} s`)); }
  }

  /** The caller's token is this plugin's current start's (§9.3: 403 otherwise). */
  private own(caller: ProtocolCaller): Session {
    const s = this.session;
    if (!s || s.exited || caller.clientId !== s.start.clientId) throw new ProtocolError(403, "forbidden", `only the token the host minted for the ${this.o.name} plugin's running process may do this`);
    return s;
  }

  private changed(event: "started" | "disconnected" | "reconnected" | "exited" | "restarting", pid: number | null = this.session?.start.pid ?? null, code: number | null = null) {
    const what = { started: `started${pid ? ` (pid ${pid})` : ""}`, disconnected: "lost its hooks stream", reconnected: "reconnected its hooks stream", exited: `exited${code !== null ? ` with code ${code}` : ""}`, restarting: "is being started again" }[event];
    this.o.emit({ type: "plugin.process_changed", stream: "daemon", entity: `plugin:${this.o.name}`, text: `The ${this.o.name} plugin's process ${what}.`, data: { plugin: this.o.name, event, pid, code, restarts: this.exits.length } });
  }

  // ---- frames ----------------------------------------------------------------------------------------------------

  private wire(call: HookCall): WireHookCall {
    const { signal: _signal, ...rest } = call;
    return (this.o.redact ? this.o.redact(rest) : rest) as WireHookCall;
  }

  private observe(call: WireHookCall) {
    remember(this.observed, call.callId);
    const bytes = JSON.stringify(call).length;
    this.outbox.push({ frame: "hook.call", call, bytes });
    this.outboxBytes += bytes;
    while (this.outbox.length > OUTBOX_FRAMES || (this.outboxBytes > OUTBOX_BYTES && this.outbox.length > 1)) {
      const old = this.outbox.shift()!;
      this.outboxBytes -= old.bytes;
      this.drops.count++;
      this.drops.hooks.add(old.call.hook);
      this.o.dropped(1);
    }
    this.pump();
  }

  /** Send what can go now: a pending `hook.dropped`, the queued observe frames, the next gate call. */
  private pump() {
    const s = this.session;
    if (!s?.sink || s.exited) return;
    if (this.drops.count) {
      this.send(s, { frame: "hook.dropped", count: this.drops.count, hooks: [...this.drops.hooks] });
      this.drops.count = 0;
      this.drops.hooks.clear();
    }
    while (this.outbox.length && s.sink) {
      const f = this.outbox.shift()!;
      this.outboxBytes -= f.bytes;
      this.send(s, { frame: "hook.call", call: f.call });
    }
    const head = this.gates[0];
    if (head && !head.sentIn && s.sink) {
      head.sentIn = s.id;
      head.seq = this.send(s, { frame: "hook.call", call: head.call });
      this.o.launcher.sent?.(this.o.name, s.start);
    }
  }

  private send(s: Session, f: { frame: "hook.call"; call: WireHookCall } | { frame: "hook.dropped"; count: number; hooks: HookName[] } | { frame: "session.closing"; reason: "daemon_stopping" | "disabled" | "replaced" }): number {
    const frame = { ...f, seq: ++s.seq } as HookFrame;
    s.ring.push({ seq: frame.seq, frame });
    if (s.ring.length > RING) s.ring.shift();
    s.sink?.frame(frame);
    return frame.seq;
  }

  /** A gate call is done with (answered, expired, failed): the next one may go. */
  private settle(g: Gate) {
    const i = this.gates.indexOf(g);
    if (i < 0) return;
    this.gates.splice(i, 1);
    g.cleanup();
    remember(this.closed, g.call.callId);
    if (i === 0) this.pump();
  }
}
