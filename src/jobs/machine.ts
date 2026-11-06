// A background job's process in its owner's machine (docs/spec/plugin-api.md §16.2): the agent's VM, or this host for a
// scripted agent, reached through the same exec its spool pump uses (src/subagents/driver.ts). Each job is a directory
// in the machine, next to the agent's spool, that outlives the daemon:
//   <dir>/<jobId>/spec.json   what to run (argv, cwd, env); runner.cjs, the runner
//   <dir>/<jobId>/rpid        the runner's pid; pid: the job's (its own process group)
//   <dir>/<jobId>/out, err    its output, as it goes
//   <dir>/<jobId>/exit        `<code>:<ms epoch>`: its exit code and when it ended (written by the runner)
//   <dir>/<jobId>/killed      why it was stopped, when capcomd stopped it
//   <dir>/<jobId>/quiet       no result message comes for it (its caller had the result, or capcomd stopped it for
//                             its agent): the supervisor doesn't keep the agent's input open for one
// The runner is a few lines of node (every machine with an in-VM capcomd has node). It starts itself again in a session
// of its own (no `setsid` needed: macOS has none), so it outlives whatever started it, the daemon included; it starts
// the command detached too, so a kill of its process group stops the whole command, and writes the exit code.
// After a daemon restart the kernel reads these files again and settles the job (§16.2 rule 6).

export interface ExecResult { code: number; stdout: string; stderr: string }
/** An agent's machine as the jobs service runs commands in it. */
export interface JobMachine {
  runId: string;
  agentId: string;
  /** Where its jobs' directories live (the spool's `jobs/`). */
  dir: string;
  /** Where a job runs when its spec names no `cwd`. */
  cwd: string;
  /** The node that runs the runner (`node` in a VM; this host's for a scripted agent). */
  node?: string;
  exec(cmd: string[], o: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
}

/** The runner, as `node <job dir>/runner.cjs <job dir>` (CommonJS; no dependencies). */
export const RUNNER = [
  `const fs=require("fs"),cp=require("child_process"),d=process.argv[2];`,
  `if(!process.env.CAPCOMD_JOB_RUNNER){cp.spawn(process.execPath,[__filename,d],{detached:true,stdio:"ignore",env:Object.assign({},process.env,{CAPCOMD_JOB_RUNNER:"1"})}).unref();process.exit(0)}`,
  `const s=JSON.parse(fs.readFileSync(d+"/spec.json","utf8")),env=Object.assign({},process.env,s.env||{});delete env.CAPCOMD_JOB_RUNNER;`,
  `fs.writeFileSync(d+"/rpid",String(process.pid));`,
  `const o=fs.openSync(d+"/out","a"),e=fs.openSync(d+"/err","a");`,
  `const fin=(c)=>{try{fs.writeFileSync(d+"/exit.tmp",c+":"+Date.now());fs.renameSync(d+"/exit.tmp",d+"/exit")}catch{}process.exit(0)};`,
  `const say=(x)=>{try{fs.writeSync(e,String(x&&x.message||x)+"\\n")}catch{}};`,
  `const sh=s.cmd.length===1;let c;`,
  `try{c=cp.spawn(sh?"/bin/sh":s.cmd[0],sh?["-c",s.cmd[0]]:s.cmd.slice(1),{cwd:s.cwd,env,stdio:["ignore",o,e],detached:true})}catch(x){say(x);fin(127)}`,
  `c.on("error",(x)=>{say(x);fin(127)});`,
  `if(c.pid)fs.writeFileSync(d+"/pid",String(c.pid));`,
  `c.on("exit",(code,sig)=>fin(code==null?128+({SIGHUP:1,SIGINT:2,SIGKILL:9,SIGTERM:15}[sig]||1):code));`,
  `for(const g of["SIGTERM","SIGINT","SIGHUP"])process.on(g,()=>{try{process.kill(-c.pid,g)}catch{}});`,
].join("");

// The node is looked for first: a job's directory with no runner in it would read as one just launched.
const LAUNCH = `set -e; command -v "$4" >/dev/null 2>&1 || { echo "no node in this machine: a job needs the node capcomd runs on" >&2; exit 127; }
mkdir -p "$1"; printf %s "$2" > "$1/spec.json"; printf %s "$3" > "$1/runner.cjs"; cd "$1"; nohup "$4" "$1/runner.cjs" "$1" >/dev/null 2>&1 </dev/null & echo started`;

/** Start the job's runner in the machine; resolves once it is started (not when the job ends). */
export async function launch(m: JobMachine, jobId: string, spec: { cmd: string[]; cwd: string; env?: Record<string, string> }): Promise<void> {
  const r = await m.exec(["sh", "-c", LAUNCH, "sh", `${m.dir}/${jobId}`, JSON.stringify(spec), RUNNER, m.node ?? "node"], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().slice(-500));
}

/** What a look at a job found: still running (with its output's size so far), ended (its exit code), or gone. */
export type Seen = { state: "running"; out: number; err: number } | { state: "exited"; code: number; at: number | null; out: number; err: number; killed: string | null } | { state: "gone"; why: string };

// One exec for every job of the machine: its exit code, whether its runner is alive, and the size of its output.
const LOOK = `D="$1"; shift; for id in "$@"; do j="$D/$id"
  if [ ! -d "$j" ]; then echo "@@J $id none"; continue; fi
  o=$(wc -c < "$j/out" 2>/dev/null | tr -d ' '); e=$(wc -c < "$j/err" 2>/dev/null | tr -d ' ')
  x=$(cat "$j/exit" 2>/dev/null || true); r=$(cat "$j/rpid" 2>/dev/null || true)
  a=dead; [ -n "$r" ] && kill -0 "$r" 2>/dev/null && a=alive
  [ -z "$x" ] && [ "$a" = dead ] && x=$(cat "$j/exit" 2>/dev/null || true)
  k=$(head -c 300 "$j/killed" 2>/dev/null | tr '\\n' ' ' || true)
  echo "@@J $id ok \${x:--} $a \${o:-0} \${e:-0} \${r:--} $k"; done`;

/** Look at `ids` in one exec. A job whose directory is gone, or whose runner died without an exit code, is `gone`. */
export async function look(m: JobMachine, ids: string[]): Promise<Map<string, Seen>> {
  const out = new Map<string, Seen>();
  if (!ids.length) return out;
  const r = await m.exec(["sh", "-c", LOOK, "sh", m.dir, ...ids], { timeoutMs: 20_000 });
  for (const line of r.stdout.split("\n")) {
    const p = /^@@J (\S+) (none|ok)(?: (\S+) (alive|dead) (\d+) (\d+) (\S+) ?(.*))?$/.exec(line.trim());
    if (!p) continue;
    const [, id, ok, exit, alive, o, e, rpid, killed] = p;
    if (ok === "none") { out.set(id!, { state: "gone", why: "its files are gone from its machine" }); continue; }
    if (exit !== "-") {
      const [code, at] = exit!.split(":");
      out.set(id!, { state: "exited", code: Number(code), at: Number(at) || null, out: Number(o), err: Number(e), killed: killed?.trim() || null });
      continue;
    }
    // No runner pid yet: just launched (the runner writes it first). A dead runner without an exit code: the machine
    // restarted under it, or it was killed from outside.
    if (alive === "dead" && rpid !== "-") { out.set(id!, { state: "gone", why: "its process is gone, with no exit code (its machine restarted?)" }); continue; }
    out.set(id!, { state: "running", out: Number(o), err: Number(e) });
  }
  return out;
}

/** New output since `from` (bytes), at most `max` bytes of each stream. */
export async function readFrom(m: JobMachine, jobId: string, from: { out: number; err: number }, max: number): Promise<{ stdout: string; stderr: string }> {
  const d = `${m.dir}/${jobId}`;
  const r = await m.exec(["sh", "-c", `tail -c +$(($2+1)) "$1/out" 2>/dev/null | head -c $4; printf '\\n@@ERR@@\\n'; tail -c +$(($3+1)) "$1/err" 2>/dev/null | head -c $4`, "sh", d, String(from.out), String(from.err), String(max)], { timeoutMs: 20_000 });
  const [stdout = "", stderr = ""] = r.stdout.split("\n@@ERR@@\n");
  return { stdout, stderr };
}

/** The last `outMax`/`errMax` bytes of its output, and whether there was more. */
export async function tails(m: JobMachine, jobId: string, outMax: number, errMax: number): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
  const d = `${m.dir}/${jobId}`;
  const r = await m.exec(["sh", "-c", `o=$(wc -c < "$1/out" 2>/dev/null | tr -d ' '); e=$(wc -c < "$1/err" 2>/dev/null | tr -d ' '); echo "\${o:-0} \${e:-0}"; tail -c $2 "$1/out" 2>/dev/null; printf '\\n@@ERR@@\\n'; tail -c $3 "$1/err" 2>/dev/null`, "sh", d, String(outMax), String(errMax)], { timeoutMs: 20_000 });
  const nl = r.stdout.indexOf("\n");
  const [o, e] = r.stdout.slice(0, nl).trim().split(/\s+/).map(Number);
  const [stdout = "", stderr = ""] = r.stdout.slice(nl + 1).split("\n@@ERR@@\n");
  return { stdout, stderr, truncated: (o ?? 0) > outMax || (e ?? 0) > errMax };
}

/** Signal the job's process group (`TERM` or `KILL`), noting why capcomd stopped it the first time. */
export async function signal(m: JobMachine, jobId: string, sig: "TERM" | "KILL", why?: string): Promise<void> {
  const d = `${m.dir}/${jobId}`;
  await m.exec(["sh", "-c", `[ -n "$3" ] && [ ! -f "$1/killed" ] && printf %s "$3" > "$1/killed"; p=$(cat "$1/pid" 2>/dev/null) && kill -"$2" -"$p" 2>/dev/null; true`, "sh", d, sig, why ?? ""], { timeoutMs: 20_000 });
}

/** Note in the job's directory that no result message comes for it (`quiet`, read by the supervisor). */
export async function noMessage(m: JobMachine, jobId: string): Promise<void> {
  await m.exec(["sh", "-c", `[ -d "$1" ] && : > "$1/quiet"; true`, "sh", `${m.dir}/${jobId}`], { timeoutMs: 20_000 });
}
