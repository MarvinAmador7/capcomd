import { delay } from "./marks";

const ROWS: Array<[string, string, string]> = [
  ["Runs", "Cloud VMs", "Containers on this machine: Docker Desktop, OrbStack, Colima, Podman"],
  ["Isolation", "A VM per agent, and a separate throwaway VM for checks", "A container: the agent can't see your files; a kernel exploit would reach the host"],
  ["Snapshots", "Yes", "Images"],
  ["Secrets", "Host-bound: the agent sees a placeholder", "An API key reaches the agent's environment; plan logins unaffected"],
  ["Egress allowlist", "Yes", "No: a profile that sets egress is refused"],
  ["In the menu bar app", "Cloud", "Local"],
];

export function Sandboxes() {
  return (
    <section className="sec" id="sandboxes" aria-labelledby="sb-title">
      <h2 className="big" id="sb-title" data-reveal><span>One agent, one VM,</span> <span>one branch.</span></h2>
      <div className="two">
        <p data-reveal>VMs come through one sandbox provider interface: create from a snapshot, exec, upload and download, egress allowlist, checkpoint and snapshot, suspend and resume, destroy. Orchestration, durability and the gates sit above it. boxd is the first provider and the one verified live.</p>
        <p data-reveal style={delay(60)}>Inside its VM an agent is unrestricted by default: every tool, open network. A profile narrows its tools, sandbox and egress. Writing a provider is documented in <code>docs/providers.md</code>.</p>
      </div>
      <div className="spec" data-reveal style={delay(120)}>
        <div className="scroll" tabIndex={0} role="region" aria-label="boxd and Docker compared">
          <table>
            <thead><tr><th scope="col"><span className="sr">Property</span></th><th scope="col">boxd</th><th scope="col">Docker</th></tr></thead>
            <tbody>{ROWS.map(([k, a, b]) => <tr key={k}><th scope="row">{k}</th><td>{a}</td><td>{b}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="spec__note">boxd is verified live end to end; Docker sandboxes arrived in 0.6. The app learns about providers from the daemon, so a new one needs no change there.</p>
      </div>
      <div className="facts">
        <div data-reveal><h3>Credentials</h3><p>VM snapshots are scrubbed of secrets. An agent&apos;s VM holds only its own login and a short-lived git credential for pushing its branch; a checks VM holds none.</p></div>
        <div data-reveal style={delay(60)}><h3>Checkpoints</h3><p>The engine pushes each workspace to <code>refs/capcomd/checkpoints/&lt;agent&gt;</code> every 10 minutes, after each commit and at each quarter of a budget, and deletes it once the work merges.</p></div>
        <div data-reveal style={delay(120)}><h3>Continue</h3><p>An agent stopped by a limit ends <code>failed</code> with its work on its branch. <code>spawn --continue agt</code> starts a new agent from that branch, or from the last checkpoint if it crashed or was cancelled.</p></div>
      </div>
    </section>
  );
}
