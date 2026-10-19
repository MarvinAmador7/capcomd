import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Git } from "../../src/merge/git";

interface FakePr {
  number: number; node_id: string; state: "open" | "closed"; merged: boolean; merged_at: string | null;
  merge_commit_sha: string | null; mergeable_state: string; head: { ref: string; sha: string }; base: { ref: string };
  title: string; body: string; autoMerge: string | null;
}

/**
 * Fake GitHub REST (+ the one GraphQL mutation) backed by a real bare repo. Merges really happen
 * in the bare repo. Knobs: required checks pending, a merge queue (auto-merge only), call log.
 */
export function fakeGitHub(bare: string, opts: { requireChecks?: boolean; mergeQueue?: boolean } = {}) {
  const pulls: FakePr[] = [];
  const calls: string[] = [];
  let checksPassing = !opts.requireChecks;
  const work = mkdtempSync(join(tmpdir(), "fakegh-"));
  const git = new Git(work);
  let ready: Promise<void> = (async () => {
    await git.ok(["init", "-q"]);
    await git.ok(["remote", "add", "origin", bare]);
  })();

  async function doMerge(pr: FakePr, method: string): Promise<{ ok: boolean; sha?: string; message?: string }> {
    await ready;
    await git.ok(["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
    const base = await git.ok(["rev-parse", `origin/${pr.base.ref}`]);
    const head = await git.ok(["rev-parse", `origin/${pr.head.ref}`]);
    await git.ok(["checkout", "-q", "--detach", "-f", base]);
    let r;
    if (method === "squash") {
      r = await git.run(["merge", "--squash", head]);
      if (r.code === 0) r = await git.run(["commit", "-q", "-m", `${pr.title} (#${pr.number})\n\n${pr.body}`]);
    } else if (method === "rebase") {
      await git.ok(["checkout", "-q", "--detach", "-f", head]);
      r = await git.run(["rebase", base]);
    } else {
      r = await git.run(["merge", "--no-ff", "-m", `Merge pull request #${pr.number}`, head]);
    }
    if (r.code !== 0) {
      await git.run(["rebase", "--abort"]); await git.run(["merge", "--abort"]); await git.run(["reset", "-q", "--hard"]);
      pr.mergeable_state = "dirty";
      return { ok: false, message: "Pull Request is not mergeable" };
    }
    const sha = await git.ok(["rev-parse", "HEAD"]);
    const push = await git.run(["push", "-q", `--force-with-lease=refs/heads/${pr.base.ref}:${base}`, "origin", `${sha}:refs/heads/${pr.base.ref}`]);
    if (push.code !== 0) return { ok: false, message: "Base branch was modified" };
    Object.assign(pr, { merged: true, merged_at: new Date().toISOString(), merge_commit_sha: sha, state: "closed", mergeable_state: "unknown" });
    return { ok: true, sha };
  }

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const view = (p: FakePr) => ({ ...p });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);
      if (req.headers.get("authorization") !== "Bearer fake-token") return json(401, { message: "Bad credentials" });
      let m;
      if (req.method === "POST" && url.pathname === "/graphql") {
        const body: any = await req.json();
        const pr = pulls.find((p) => p.node_id === body.variables?.id);
        if (!pr) return json(200, { errors: [{ message: "not found" }] });
        pr.autoMerge = String(body.variables.m).toLowerCase();
        if (checksPassing && !opts.mergeQueue) await doMerge(pr, pr.autoMerge);
        return json(200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } });
      }
      if ((m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls$/))) {
        if (req.method === "GET") {
          const head = (url.searchParams.get("head") ?? "").split(":").pop();
          const base = url.searchParams.get("base");
          return json(200, pulls.filter((p) => p.head.ref === head && (!base || p.base.ref === base)).map(view).reverse());
        }
        const b: any = await req.json();
        if (pulls.some((p) => p.head.ref === b.head && p.state === "open")) return json(422, { message: "A pull request already exists" });
        await ready;
        await git.ok(["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
        const sha = await git.ok(["rev-parse", `origin/${b.head}`]);
        const pr: FakePr = { number: pulls.length + 1, node_id: `PR_${pulls.length + 1}`, state: "open", merged: false, merged_at: null, merge_commit_sha: null, mergeable_state: checksPassing ? "clean" : "blocked", head: { ref: b.head, sha }, base: { ref: b.base }, title: b.title, body: b.body, autoMerge: null };
        pulls.push(pr);
        return json(201, view(pr));
      }
      if ((m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)(\/merge)?$/))) {
        const pr = pulls.find((p) => p.number === Number(m![1]));
        if (!pr) return json(404, { message: "Not Found" });
        if (!m[2]) return json(200, view(pr));
        if (pr.merged) return json(405, { message: "Pull Request is not mergeable" });
        const b: any = await req.json();
        if (b.sha && b.sha !== pr.head.sha) return json(409, { message: "Head branch was modified. Review and try the merge again." });
        if (!checksPassing) return json(405, { message: "Required status check \"ci\" is expected." });
        if (opts.mergeQueue) return json(405, { message: "Changes must be made through the merge queue" });
        pr.title = b.commit_title ?? pr.title; pr.body = b.commit_message ?? pr.body;
        const res = await doMerge(pr, b.merge_method ?? "merge");
        return res.ok ? json(200, { merged: true, sha: res.sha, message: "Pull Request successfully merged" }) : json(405, { message: res.message });
      }
      return json(404, { message: "Not Found" });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    pulls, calls,
    /** Required checks go green; auto-merge / the queue then merges. */
    async passChecks() {
      checksPassing = true;
      for (const pr of pulls) {
        if (pr.state === "open") pr.mergeable_state = "clean";
        if (pr.state === "open" && pr.autoMerge) await doMerge(pr, pr.autoMerge);
      }
    },
    stop: () => server.stop(true),
  };
}
