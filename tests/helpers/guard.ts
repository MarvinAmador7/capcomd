// The test isolation guard: no test (nor any bun process a test starts) may reach a developer's own daemon
// (127.0.0.1:6420, its api-peer :6421, its metrics :6430) or write under their real ~/.capcomd.
//
// tests/helpers/isolate-config.ts (the bunfig preload) installs it in every test file's process, and hands it to every
// bun process a test starts through BUN_OPTIONS (tests/helpers/guard-child.ts). A forbidden connection or write throws
// before it happens, and is also appended to CAPCOMD_TEST_GUARD_LOG: code that swallows the error (a probe that treats
// any failure as "down") can't hide it, because the preload's afterAll fails the test file on any line there.
//
// Covered: fetch, WebSocket, net and everything over it (node:http), Bun.connect; the fs module's write calls (sync,
// callback and promises) and Bun.write. In the test process the named imports (`import { writeFileSync } from "fs"`)
// are covered too (mock.module); in a child only the module objects are, so a capcomd child also checks at startup that
// its home isn't the real ~/.capcomd (every path it writes there comes from that home).
import fs from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";

/** A developer's daemon: the engine's guard port, its api-peer (+1) and its metrics (+10). */
export const FORBIDDEN_PORTS = [6420, 6421, 6430] as const;
const LOOPBACK = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::", "[::]"]);
/** The real ~/.capcomd, whatever HOME a test sets: bun's userInfo() follows HOME, so the test process (whose HOME is the
 *  developer's) works it out and hands it to its children (CAPCOMD_TEST_REAL_HOME). */
export const REAL_CAPCOMD_HOME = process.env.CAPCOMD_TEST_REAL_HOME || join(userInfo().homedir, ".capcomd");
export const GUARDED = Symbol.for("capcomd.test-guard");

const appendRaw = fs.appendFileSync;
const realOr = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };

// The guard's own test adds a harmless port and directory (CAPCOMD_TEST_GUARD_PORTS / _DIRS) to prove it works without
// going near the real ones; read at each check, so it can set them after the preload ran.
const extra = (k: string) => (process.env[k] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const forbiddenPorts = (): number[] => [...FORBIDDEN_PORTS, ...extra("CAPCOMD_TEST_GUARD_PORTS").map(Number)];
export const guardedRoots = (): string[] => [...new Set([REAL_CAPCOMD_HOME, realOr(REAL_CAPCOMD_HOME), ...extra("CAPCOMD_TEST_GUARD_DIRS").map((d) => resolve(d))])];

/** Record a violation (CAPCOMD_TEST_GUARD_LOG) and return the error to throw. */
export function violation(what: string): Error {
  const msg = `test isolation: ${what} [pid ${process.pid}: ${process.argv.slice(1).join(" ").slice(0, 200)}]`;
  const log = process.env.CAPCOMD_TEST_GUARD_LOG;
  if (log) try { appendRaw(log, msg.replace(/\n/g, " ") + "\n"); } catch {}
  return new Error(msg);
}

function forbiddenHostPort(host: unknown, port: unknown): boolean {
  const p = Number(port);
  if (!Number.isInteger(p) || !forbiddenPorts().includes(p)) return false;
  const h = host === undefined || host === null ? "" : String(host).toLowerCase();
  return LOOPBACK.has(h) || h.startsWith("127.");
}
function forbiddenUrl(u: unknown): string | null {
  let url: URL;
  try { url = new URL(typeof u === "string" ? u : u instanceof URL ? u.href : (u as { url?: string })?.url ?? ""); } catch { return null; }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return forbiddenHostPort(url.hostname, port) ? url.href : null;
}
const checkUrl = (u: unknown, via: string) => { const bad = forbiddenUrl(u); if (bad) throw violation(`${via} ${bad}: a developer's daemon port (${FORBIDDEN_PORTS.join(", ")}); point CAPCOMD_ENDPOINT at the test's own engine`); };

function insideGuarded(p: unknown): string | null {
  let s: string;
  if (typeof p === "string") s = p;
  else if (p instanceof URL) { if (p.protocol !== "file:") return null; s = p.pathname; }
  else if (Buffer.isBuffer(p)) s = p.toString();
  else return null;
  const abs = resolve(s);
  for (const root of guardedRoots()) if (abs === root || abs.startsWith(`${root}/`)) return abs;
  return null;
}
const checkPath = (p: unknown, via: string) => { const bad = insideGuarded(p); if (bad) throw violation(`${via} ${bad}: inside the real ${REAL_CAPCOMD_HOME}; tests use their own CAPCOMD_HOME`); };

const WRITE_FLAGS = /[wa+]/;
const writes = (flags: unknown) => typeof flags === "string" ? WRITE_FLAGS.test(flags)
  : typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0 : false;

// The fs calls that write, by name, and which arguments are the paths they write (cp, copyFile, symlink, link: the
// destination; rename: both).
const FS_WRITES: Record<string, number[]> = {
  writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rename: [0, 1], rm: [0], rmdir: [0], unlink: [0],
  cp: [1], copyFile: [1], symlink: [1], link: [1], truncate: [0], chmod: [0], chown: [0], utimes: [0], lchown: [0],
};

function wrapFs(target: Record<string, any>, names: string[], via: string, promises = false) {
  for (const name of names) {
    const orig = target[name];
    if (typeof orig !== "function" || orig[GUARDED]) continue;
    const base = name.replace(/Sync$/, "");
    const check = (args: any[]) => {
      if (base === "open") { if (writes(args[1])) checkPath(args[0], `${via}.${name}`); }
      else if (name === "createWriteStream") checkPath(args[0], `${via}.${name}`);
      else for (const i of FS_WRITES[base] ?? []) checkPath(args[i], `${via}.${name}`);
    };
    const wrapped = function (this: unknown, ...args: any[]) {
      if (promises) { try { check(args); } catch (e) { return Promise.reject(e); } }
      else check(args);
      return orig.apply(this, args);
    };
    Object.defineProperty(wrapped, GUARDED, { value: true });
    Object.defineProperty(wrapped, "name", { value: name });
    try { target[name] = wrapped; } catch {}
  }
}

const fsNames = [...Object.keys(FS_WRITES).flatMap((n) => [n, `${n}Sync`]), "open", "openSync", "createWriteStream"];

/** Install the guard in this process (idempotent). Returns the patched fs and fs.promises, for the test process's mock.module. */
export function installGuard(): { fs: typeof fs; promises: typeof fs.promises } {
  const g = globalThis as any;
  if (!g.fetch[GUARDED]) {
    const orig = g.fetch;
    const guarded = Object.assign(function fetch(input: unknown, init?: unknown) {
      try { checkUrl(input, "fetch"); } catch (e) { return Promise.reject(e); }
      return orig(input, init);
    }, orig, { [GUARDED]: true });
    g.fetch = guarded;
  }
  if (g.WebSocket && !g.WebSocket[GUARDED]) {
    const Orig = g.WebSocket;
    const Guarded = class WebSocket extends Orig {
      constructor(url: unknown, ...rest: unknown[]) { checkUrl(url, "WebSocket"); super(url, ...rest); }
    };
    Object.defineProperty(Guarded, GUARDED, { value: true });
    g.WebSocket = Guarded;
  }
  const proto = net.Socket.prototype as any;
  if (!proto.connect[GUARDED]) {
    const orig = proto.connect;
    proto.connect = Object.assign(function (this: unknown, ...args: any[]) {
      const [a, b] = Array.isArray(args[0]) ? args[0] : args; // http passes [options, cb] as one argument
      const o = a && typeof a === "object" ? a : { port: a, host: typeof b === "string" ? b : undefined };
      if (o.port !== undefined && o.port !== null && forbiddenHostPort(o.host ?? o.hostname, o.port)) throw violation(`net connect ${o.host ?? o.hostname ?? "localhost"}:${o.port}: a developer's daemon port`);
      return orig.apply(this, args);
    }, { [GUARDED]: true });
  }
  const B = (globalThis as any).Bun;
  if (B?.connect && !B.connect[GUARDED]) {
    const orig = B.connect;
    try {
      B.connect = Object.assign(function (o: any) {
        if (o && !o.unix && forbiddenHostPort(o.hostname, o.port)) throw violation(`Bun.connect ${o.hostname}:${o.port}: a developer's daemon port`);
        return orig.call(B, o);
      }, { [GUARDED]: true });
    } catch {}
  }
  if (B?.write && !B.write[GUARDED]) {
    const orig = B.write;
    try {
      B.write = Object.assign(function (dest: any, ...rest: any[]) {
        checkPath(typeof dest?.name === "string" ? dest.name : dest, "Bun.write");
        return orig.call(B, dest, ...rest);
      }, { [GUARDED]: true });
    } catch {}
  }
  wrapFs(fs as any, fsNames, "fs");
  wrapFs(fs.promises as any, Object.keys(FS_WRITES).concat("open"), "fs.promises", true);
  return { fs, promises: fs.promises };
}

/** The violations recorded so far in this file's log (and empties it): for the guard's own test. */
export function takeViolations(): string[] {
  const log = process.env.CAPCOMD_TEST_GUARD_LOG;
  if (!log || !fs.existsSync(log)) return [];
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  fs.truncateSync(log, 0);
  return lines;
}
