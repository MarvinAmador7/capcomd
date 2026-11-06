// src/merge/transfer.ts with a big repository (the 2026-11-05 boxd measurement: a 478 MB bundle took 20+ minutes to
// reach each VM): the host's mirror fetch is bounded by a stall, not a fixed 10 minutes; bundles go to the sandbox and
// come back a chunk at a time from disk; and a long transfer reports its progress (to its caller, as `git.progress`
// events on its span, and in one line for a log). The sandbox is FakeProvider's host mode, so its commands run here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "./gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { AGENT_EGRESS } from "../../src/agents/config";
import { Git } from "../../src/merge/git";
import { progressLine, pushFromSandbox, sendToSandbox, TransferError, type SandboxGit, type TransferProgress } from "../../src/merge/transfer";
import { getFinishedSpans } from "../../src/utils/tracing-simple";

const KNOBS = ["CAPCOMD_TRANSFER_CHUNK_BYTES", "CAPCOMD_TRANSFER_PROGRESS_SECONDS", "CAPCOMD_GIT_STALL_SECONDS", "GIT_SSH_COMMAND"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]])); });
afterEach(() => { for (const k of KNOBS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

const CHUNK = 64 * 1024;

/** A sandbox (host mode) whose uploads and downloads are counted, with the biggest single call's size. */
async function sandbox() {
  const p = new FakeProvider({ hostExec: true });
  const { id } = await p.ensure({ idemKey: `xfer-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await p.waitReady(id, 1000);
  const seen = { uploads: 0, downloads: 0, biggest: 0 };
  const box: SandboxGit = {
    exec: (cmd, o) => p.exec(id, cmd, { env: { PATH: process.env.PATH ?? "", HOME: tmpdir() }, ...o }),
    upload: async (a, d) => { seen.uploads++; seen.biggest = Math.max(seen.biggest, d.length); await p.upload(id, a, d); },
    download: async (a) => { const d = await p.download(id, a); seen.downloads++; seen.biggest = Math.max(seen.biggest, d.length); return d; },
  };
  return { box, seen };
}

/** A repository whose main has a file of `bytes` random (incompressible) bytes. */
async function bigRepo(bytes: number) {
  const r = await bareRepo();
  const seed = join(r.root, "seed");
  writeFileSync(join(seed, "big.bin"), randomBytes(bytes));
  await r.seed.ok(["add", "big.bin"]);
  await r.seed.ok(["commit", "-q", "-m", "big"]);
  await r.seed.ok(["push", "-q", "origin", "main"]);
  return r;
}

describe("bundles a chunk at a time", () => {
  test("a clone bigger than a chunk is uploaded in chunks, joined in the sandbox, and reported", async () => {
    process.env.CAPCOMD_TRANSFER_CHUNK_BYTES = String(CHUNK);
    process.env.CAPCOMD_TRANSFER_PROGRESS_SECONDS = "0";
    const r = await bigRepo(5 * CHUNK);
    const { box, seen } = await sandbox();
    const work = mkdtempSync(join(tmpdir(), "capcomd-xfer-"));
    const dir = join(work, "repo");
    const heard: TransferProgress[] = [];
    const res = await sendToSandbox({ remote: r.bare, workdir: join(work, "host") }, box, dir, { branches: "all", checkout: "main", onProgress: (p) => heard.push(p) }, { fresh: true });

    expect(res.bytes).toBeGreaterThan(5 * CHUNK);
    expect(seen.uploads).toBeGreaterThanOrEqual(6);
    expect(seen.biggest).toBeLessThanOrEqual(CHUNK);
    // The checkout is the remote's main, and nothing of the transfer is left behind in the sandbox.
    expect((await new Git(dir).ok(["rev-parse", "HEAD"])).trim()).toBe((await r.sha("main"))!);
    expect((await new Git(dir).ok(["status", "--porcelain"]))).toBe("");
    expect(readdirSync("/tmp").filter((f) => f.startsWith(`capcomd-in-${process.pid}-`))).toEqual([]);

    const uploads = heard.filter((p) => p.phase === "upload");
    expect(uploads.length).toBeGreaterThanOrEqual(6);
    expect(uploads.every((p) => p.total === res.bytes)).toBe(true);
    expect(uploads.at(-1)).toMatchObject({ done: true, bytes: res.bytes });
    expect(heard.some((p) => p.phase === "fetch" && p.done)).toBe(true);
    // The span says how much went, and carries the reports.
    const span = getFinishedSpans().filter((s) => s.name === "git.clone").at(-1)!;
    expect(span.attributes["git.bytes"]).toBe(res.bytes);
    expect(span.events.filter((e) => e.name === "git.progress" && e.attributes?.["git.phase"] === "upload").length).toBe(uploads.length);
  }, 60_000);

  test("a pushed commit bigger than a chunk comes back in chunks and lands on the remote", async () => {
    process.env.CAPCOMD_TRANSFER_CHUNK_BYTES = String(CHUNK);
    process.env.CAPCOMD_TRANSFER_PROGRESS_SECONDS = "0";
    const r = await bareRepo();
    const { box, seen } = await sandbox();
    const work = mkdtempSync(join(tmpdir(), "capcomd-xfer-"));
    const h = { remote: r.bare, workdir: join(work, "host") };
    const dir = join(work, "repo");
    await sendToSandbox(h, box, dir, { branches: "all", checkout: "main" }, { fresh: true });
    writeFileSync(join(dir, "work.bin"), randomBytes(4 * CHUNK));
    const c = await box.exec(["sh", "-c", `cd '${dir}' && git add -A && git -c user.name=a -c user.email=a@a commit -qm work && git rev-parse HEAD`]);
    const sha = c.stdout.trim().split("\n").pop()!;
    const heard: TransferProgress[] = [];
    seen.downloads = 0; seen.biggest = 0;

    const res = await pushFromSandbox(h, box, dir, { sha, ref: "refs/heads/capcomd/r/t", expect: null, near: ["main"], onProgress: (p) => heard.push(p) });
    expect(await r.sha("refs/heads/capcomd/r/t")).toBe(sha);
    expect(res.bytes).toBeGreaterThan(4 * CHUNK);
    expect(seen.downloads).toBeGreaterThanOrEqual(5);
    expect(seen.biggest).toBeLessThanOrEqual(CHUNK);
    expect(heard.filter((p) => p.phase === "download").at(-1)).toMatchObject({ done: true, bytes: res.bytes, total: res.bytes });
    expect(readdirSync("/tmp").filter((f) => f.startsWith(`capcomd-out-${process.pid}-`))).toEqual([]);
  }, 60_000);

  test("small transfers are one call each, and say nothing", async () => {
    process.env.CAPCOMD_TRANSFER_PROGRESS_SECONDS = "15";
    const r = await bareRepo();
    const { box, seen } = await sandbox();
    const work = mkdtempSync(join(tmpdir(), "capcomd-xfer-"));
    const heard: TransferProgress[] = [];
    await sendToSandbox({ remote: r.bare, workdir: join(work, "host") }, box, join(work, "repo"), { branches: "all", checkout: "main", onProgress: (p) => heard.push(p) }, { fresh: true });
    expect(seen.uploads).toBe(1);
    expect(heard).toEqual([]);
  }, 30_000);
});

describe("the mirror's fetch", () => {
  test("ends when the remote goes quiet (a stall), with a message that says so", async () => {
    process.env.CAPCOMD_GIT_STALL_SECONDS = "1";
    // An ssh "server" that never answers: git waits on it, writing nothing.
    process.env.GIT_SSH_COMMAND = "sh -c 'sleep 30' --";
    const { box } = await sandbox();
    const work = mkdtempSync(join(tmpdir(), "capcomd-xfer-"));
    const t0 = Date.now();
    const err = await sendToSandbox({ remote: "ssh://git@example.invalid/acme/big.git", workdir: join(work, "host") }, box, join(work, "repo"), { branches: "all", checkout: "main" }, { fresh: true }).catch((e) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect(String(err.message)).toContain("made no progress for 1 s");
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});

describe("progressLine", () => {
  test("says what moved, how much, how fast and how long", () => {
    expect(progressLine("git clone", { phase: "upload", bytes: 120 * 1024 ** 2, total: 478 * 1024 ** 2, ms: 308_000, done: false }))
      .toBe("git clone: uploading 120.0 MB of 478.0 MB (25%) to the sandbox, 5m 08s at 0.39 MB/s");
    expect(progressLine("git clone", { phase: "upload", bytes: 478 * 1024 ** 2, total: 478 * 1024 ** 2, ms: 1_225_000, done: true }))
      .toBe("git clone: uploaded 478.0 MB to the sandbox in 20m 25s at 0.39 MB/s");
    expect(progressLine("git push", { phase: "download", bytes: 2 * 1024 ** 2, total: 4 * 1024 ** 2, ms: 20_000, done: false }))
      .toBe("git push: downloading 2.0 MB of 4.0 MB (50%) from the sandbox, 20s at 0.10 MB/s");
    expect(progressLine("git clone", { phase: "fetch", bytes: 0, total: null, ms: 45_000, done: false, line: "Receiving objects:  45% (1/2), 212.00 MiB | 1.20 MiB/s" }))
      .toBe("git clone: the host is fetching the repository into its mirror: Receiving objects:  45% (1/2), 212.00 MiB | 1.20 MiB/s (45s)");
  });
});
