import type { CSSProperties, ReactNode } from "react";
import { AgentSuffix, Bot } from "./crew";
import { delay } from "./marks";
import { RUNTIME_PATHS } from "@/lib/runtime-icons";

/** boxd's mark, as boxd.sh draws it in its header (one path; coloured by the text around it). */
const BoxdMark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M2 0h20a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H6.8a2 2 0 0 1-2-2v-.8a2 2 0 0 0-2-2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2Z" /></svg>
);

/** A numbered pin on the picture, matching a promise below it. */
const Pin = ({ n, className }: { n: number; className: string }) => <span className={`sbx__pin ${className}`} aria-hidden="true">{n}</span>;

// The three rooms, left to right: one merged, one being checked, one still working (with its last save).
const ROOMS: Array<{ i: number; state: "merged" | "checking" | "working" }> = [{ i: 1, state: "merged" }, { i: 2, state: "checking" }, { i: 3, state: "working" }];

const PROMISES: Array<[string, ReactNode]> = [
  ["Walled off.", "A VM in the cloud, or a container on your machine. It can't see your files or the other agents."],
  ["Its own copy of the code.", "Each agent works on its own branch, so no agent can overwrite another's work."],
  ["Checked before it joins.", "Your checks run in a fresh, throwaway machine, on the branch merged with the latest main. Only what passes is merged."],
  ["Saved as it goes.", "Its work is pushed every 10 minutes and after every commit. If its computer dies, a new agent can pick up from the last save."],
];

/** Three agents in their rooms; each one's branch runs down through the checks into main. */
function Rooms() {
  return (
    <figure className="sbx__pic" data-reveal style={delay(120)} aria-label="Three agents, each in its own computer on its own branch. The first one's branch passed its checks and is merged into main; the second's is being checked; the third is still working and was saved two minutes ago.">
      <div className="sbx__rooms">
        {ROOMS.map(({ i, state }, k) => (
          <div key={i} className={`sbx__lane is-${state}`} style={{ "--k": k } as CSSProperties}>
            <div className="sbx__room">
              {k === 0 ? <Pin n={1} className="sbx__pin--room" /> : null}
              <p className="sbx__who">worker <AgentSuffix i={i} /></p>
              <Bot i={i} className="sbx__bot" mood={state === "merged" ? "happy" : undefined} pose={state === "merged" ? "cheer" : undefined} />
              <p className="sbx__st">{state === "merged" ? "merged" : state === "checking" ? "being checked" : "working"}</p>
              <p className={`sbx__saved${state === "working" ? "" : " is-empty"}`} aria-hidden={state !== "working" || undefined}>{state === "working" ? <><Pin n={4} className="sbx__pin--save" />saved 2 min ago</> : "\u00a0"}</p>
            </div>
            <div className="sbx__wire" aria-hidden="true">
              {k === 0 ? <Pin n={2} className="sbx__pin--wire" /> : null}
              <i /><i /><i />
            </div>
            <p className="sbx__gate" aria-hidden="true">
              {k === 1 ? <Pin n={3} className="sbx__pin--gate" /> : null}
              {state === "merged" ? "✓ checked" : state === "checking" ? "checking…" : "checks"}
            </p>
            <span className="sbx__join" aria-hidden="true"><i /></span>
          </div>
        ))}
      </div>
      <p className="sbx__main" aria-hidden="true"><span>main</span></p>
    </figure>
  );
}

export function Sandboxes() {
  return (
    <section className="sec" id="sandboxes" aria-labelledby="sb-title">
      <h2 className="big" id="sb-title" data-reveal><span>Every agent gets</span> <span>its own computer.</span></h2>
      <p className="sbx__lead" data-reveal style={delay(60)}>And its own copy of your code. Agents can&apos;t step on each other or touch your machine, and their work joins yours only after it&apos;s been checked.</p>

      <Rooms />

      <ol className="sbx__promises">
        {PROMISES.map(([t, d], k) => (
          <li key={t} data-reveal style={delay(60 * k)}><span className="sbx__num" aria-hidden="true">{k + 1}</span><h3>{t}</h3><p>{d}</p></li>
        ))}
      </ol>

      <div className="sbx__where" data-reveal style={delay(80)}>
        <h3 className="sbx__wh">Where they run</h3>
        <table className="sbx__table">
          <thead>
            <tr>
              <td />
              <th scope="col"><span className="sbx__prov"><BoxdMark className="sbx__boxd" />boxd</span><small>in the cloud</small></th>
              <th scope="col">
                <span className="sbx__prov">Docker</span><small>on your machine</small>
                <span className="sbx__logos" aria-label="Docker Desktop, OrbStack, Colima or Podman">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#2496ED" d={RUNTIME_PATHS.docker} /></svg>
                  <img src="/logos/orbstack.png" alt="" width={40} height={40} />
                  <img src="/logos/colima.png" alt="" width={40} height={40} />
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#892CA0" d={RUNTIME_PATHS.podman} /></svg>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr><th scope="row">Each agent gets</th><td>a whole VM</td><td>a container</td></tr>
            <tr><th scope="row">To start</th><td>a boxd account</td><td>no account</td></tr>
            <tr><th scope="row">An API key</th><td>never visible to the agent</td><td>visible to the agent (not a plan login)</td></tr>
            <tr><th scope="row">Limit the sites it can reach</th><td>yes, per role</td><td>no</td></tr>
          </tbody>
        </table>
      </div>

      <details className="sbx__eng">
        <summary>For engineers: credentials, checkpoints and limits</summary>
        <dl>
          <div><dt>Inside its machine</dt><dd>An agent is unrestricted by default: every tool, open network. A profile narrows its tools, sandbox and egress; on Docker a profile that sets <code>egress</code> is refused rather than run unrestricted.</dd></div>
          <div><dt>Credentials</dt><dd>VM snapshots are scrubbed of secrets. An agent&apos;s VM holds only its own login; agents never hold push credentials, and a checks VM holds none.</dd></div>
          <div><dt>Checkpoints</dt><dd>The engine pushes each workspace to <code>refs/capcomd/checkpoints/&lt;agent&gt;</code> every 10 minutes, after each commit and at each quarter of a budget, and deletes it once the work merges.</dd></div>
          <div><dt>Continue</dt><dd>An agent stopped by a limit ends <code>failed</code> with its work on its branch. <code>spawn --continue agt</code> starts a new agent from that branch, or from the last checkpoint if it crashed or was cancelled.</dd></div>
        </dl>
      </details>
    </section>
  );
}
