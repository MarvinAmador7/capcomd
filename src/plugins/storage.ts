// A plugin's private storage (plugin API §8.4, §9.6): `ctx.storage` in process and /v1/plugins/{name}/storage out of
// process. The daemon scope is one JSON file in the plugin's data directory (<home>/state/plugins/<name>/storage.json,
// 0600), which survives updates and reinstalls; a run's scope is the run's kv under `plugin/<name>/` (a reserved prefix
// a plugin's `ctx.kv` can't write), so it goes with the run. Keys `^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$`, values JSON of
// at most 64 KB. A write with `expect` (the JSON text of the current value, or null: none) is a compare-and-swap.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginError } from "../../packages/plugin/src/errors";
import type { StorageService } from "../../packages/plugin/src/context";

export type StorageScope = "daemon" | { runId: string };
export interface StoredEntry { key: string; value: unknown; rev: string }
export interface PluginStore {
  get(scope: StorageScope, key: string): Promise<StoredEntry | null>;
  /** `expect` undefined: write as is; a string: only over that JSON value; null: only when the key is unset. A
   *  mismatch is a `conflict`. */
  put(scope: StorageScope, key: string, value: unknown, expect?: string | null): Promise<StoredEntry>;
  delete(scope: StorageScope, key: string): Promise<void>;
  list(scope: StorageScope, prefix: string): Promise<StoredEntry[]>;
}

export const STORAGE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/;
const VALUE_MAX = 64 * 1024;

const checkKey = (key: string) => { if (!STORAGE_KEY.test(key)) throw new PluginError("invalid", `storage key ${JSON.stringify(key.slice(0, 64))}: letters, digits, ".", "_", "/" and "-", at most 200, starting with a letter or digit (§8.4)`); };
const checkPrefix = (prefix: string) => { if (prefix && !/^[a-zA-Z0-9._/-]{0,200}$/.test(prefix)) throw new PluginError("invalid", "a storage prefix uses the characters of a key"); };
function checkValue(value: unknown): string {
  if (value === undefined) throw new PluginError("invalid", "a storage value is JSON (not undefined)");
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > VALUE_MAX) throw new PluginError("invalid", "a storage value is at most 64 KB of JSON (§8.4)");
  return text;
}
const conflict = (key: string) => new PluginError("conflict", `storage ${key}: its value isn't the one expected`);

/** The storage of plugin `name`, whose data directory is `dataDir`. */
export function pluginStore(name: string, dataDir: string): PluginStore {
  const file = join(dataDir, "storage.json");
  type Doc = { entries: Record<string, { value: unknown; rev: number }> };
  const read = (): Doc => {
    if (!existsSync(file)) return { entries: {} };
    try { const d = JSON.parse(readFileSync(file, "utf8")) as Doc; return d && typeof d.entries === "object" ? d : { entries: {} }; } catch { return { entries: {} }; }
  };
  const write = (d: Doc) => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  };
  const prefix = `plugin/${name}/`;
  const scope = async (runId: string) => {
    const { existingActor } = await import("../core/relay");
    const s = /^run-[A-Za-z0-9_-]+$/.test(runId) ? await existingActor("scope", [runId]) : null;
    if (!s) throw new PluginError("not_found", `no run ${runId.slice(0, 64)}`);
    return s;
  };
  const kvEntry = (k: string, r: { value: unknown; version: number }): StoredEntry => ({ key: k.slice(prefix.length), value: r.value, rev: String(r.version) });
  return {
    async get(where, key) {
      checkKey(key);
      if (where === "daemon") { const e = read().entries[key]; return e ? { key, value: e.value, rev: String(e.rev) } : null; }
      const r = await (await scope(where.runId)).kvGet({ k: prefix + key }) as { value: unknown; version: number; deleted: boolean } | null;
      return r && !r.deleted ? kvEntry(prefix + key, r) : null;
    },
    async put(where, key, value, expect) {
      checkKey(key);
      const text = checkValue(value);
      if (where === "daemon") {
        const d = read();
        const cur = d.entries[key];
        if (expect !== undefined && (expect === null ? !!cur : !cur || JSON.stringify(cur.value) !== expect)) throw conflict(key);
        const rev = (cur?.rev ?? 0) + 1;
        d.entries[key] = { value: JSON.parse(text), rev };
        write(d);
        return { key, value: d.entries[key]!.value, rev: String(rev) };
      }
      const s = await scope(where.runId);
      const k = prefix + key;
      let version: number | undefined;
      if (expect !== undefined) {
        const cur = await s.kvGet({ k }) as { value: unknown; version: number; deleted: boolean } | null;
        const live = cur && !cur.deleted ? cur : null;
        if (expect === null ? !!live : !live || JSON.stringify(live.value) !== expect) throw conflict(key);
        version = cur?.version ?? 0;
      }
      try {
        const out = await s.kvWrite({ k, value: JSON.parse(text), writer: `plugin:${name}`, paramsHash: `${k}\u0000${text}`, ...(version !== undefined ? { expect: version } : {}) }) as { version: number };
        return { key, value: JSON.parse(text), rev: String(out.version) };
      } catch (e) {
        if ((e as { code?: string }).code === "cas_mismatch" || /cas_mismatch|expected/.test((e as Error).message ?? "")) throw conflict(key);
        throw e;
      }
    },
    async delete(where, key) {
      checkKey(key);
      if (where === "daemon") {
        const d = read();
        if (!(key in d.entries)) return;
        delete d.entries[key];
        write(d);
        return;
      }
      await (await scope(where.runId)).kvWrite({ k: prefix + key, value: null, del: true, writer: `plugin:${name}`, paramsHash: `${prefix + key}\u0000delete` });
    },
    async list(where, p) {
      checkPrefix(p);
      if (where === "daemon") return Object.entries(read().entries).filter(([k]) => k.startsWith(p)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, e]) => ({ key: k, value: e.value, rev: String(e.rev) }));
      const rows = await (await scope(where.runId)).kvList({ prefix: prefix + p }) as Array<{ k: string; value: unknown; version: number }>;
      return rows.map((r) => kvEntry(r.k, r));
    },
  };
}

/** `ctx.storage` (§8.1) over a plugin's store. */
export function storageService(store: PluginStore): StorageService {
  return {
    get: async (scope, key) => (await store.get(scope, key))?.value,
    put: async (scope, key, value) => { await store.put(scope, key, value); },
    cas: async (scope, key, expect, value) => {
      try { await store.put(scope, key, value, expect === undefined ? null : JSON.stringify(expect)); return true; } catch (e) {
        if (e instanceof PluginError && e.code === "conflict") return false;
        throw e;
      }
    },
    delete: (scope, key) => store.delete(scope, key),
    list: async (scope, prefix) => (await store.list(scope, prefix)).map((e) => e.key),
  };
}
