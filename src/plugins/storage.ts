// `ctx.storage` (docs/spec/plugin-api.md §8.1, §8.4): a plugin's own small records. The daemon scope is files in the
// plugin's data directory (state/plugins/<name>/storage/), which survive restarts, updates and reinstalls: where a
// trigger source keeps its read position (§16.3.1), so a restart doesn't replay what it already emitted. The run scope
// (deleted with the run) is a later step's: `unsupported` until then.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StorageService } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/;
const VALUE_MAX = 64 * 1024;

/** The daemon-scope storage of the plugin whose data directory is `dataDir`. */
export function pluginStorage(dataDir: string): StorageService {
  const root = join(dataDir, "storage");
  const where = (scope: unknown, key: string): string => {
    if (scope !== "daemon") throw new PluginError("unsupported", "run-scope storage is not available to plugins yet: use \"daemon\"");
    if (typeof key !== "string" || !KEY.test(key) || key.split("/").includes("..")) throw new PluginError("invalid", `storage key ${JSON.stringify(key)}: letters, digits, . _ / -, at most 200 (§8.4)`);
    return join(root, `${encodeURIComponent(key)}.json`);
  };
  const read = (path: string): { has: boolean; text: string | null } => {
    try { return { has: true, text: readFileSync(path, "utf8") }; } catch { return { has: false, text: null }; }
  };
  const write = (path: string, value: unknown) => {
    const text = JSON.stringify(value);
    if (text === undefined) throw new PluginError("invalid", "a stored value is JSON");
    if (Buffer.byteLength(text) > VALUE_MAX) throw new PluginError("invalid", "a stored value is at most 64 KB");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    async get(scope, key) { const r = read(where(scope, key)); return r.has ? JSON.parse(r.text!) : undefined; },
    async put(scope, key, value) { write(where(scope, key), value); },
    async cas(scope, key, expect, value) {
      const path = where(scope, key);
      const r = read(path);
      if (expect === undefined ? r.has : !r.has || r.text !== JSON.stringify(expect)) return false;
      write(path, value);
      return true;
    },
    async delete(scope, key) { rmSync(where(scope, key), { force: true }); },
    async list(scope, prefix) {
      where(scope, "x");
      if (!existsSync(root)) return [];
      return readdirSync(root).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5))).filter((k) => k.startsWith(prefix ?? "")).sort();
    },
  };
}
