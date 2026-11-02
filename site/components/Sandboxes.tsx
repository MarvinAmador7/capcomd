import type { CSSProperties, ReactNode } from "react";
import { AgentSuffix, Bot } from "./crew";
import { delay } from "./marks";
import { RUNTIME_PATHS } from "@/lib/runtime-icons";


/** boxd's mark, as boxd.sh draws it in its header (one path; coloured by the text around it). */
const BoxdMark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M2 0h20a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H6.8a2 2 0 0 1-2-2v-.8a2 2 0 0 0-2-2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2Z" /></svg>
);

// Small line glyphs for the machine cards (decorative; the text says it).
const G = {
  key: <><circle cx="5" cy="8" r="3" /><path d="M8 8h6M12 8v3M14 8v2" /></>,
  branch: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="5.5" r="1.6" /><path d="M4 5.1v5.8M12 7.1c0 3-8 2-8 3.8" /></>,
  net: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c-2.4 2.8-2.4 9.2 0 12M8 2c2.4 2.8 2.4 9.2 0 12" /></>,
  nokey: <><circle cx="5" cy="8" r="3" /><path d="M8 8h6M12 8v3M2 14 14 2" /></>,
  merge: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M4 5.5c0 4 8 3 8 5.4" /></>,
  bin: <><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9" /></>,
};
const Line = ({ g, children }: { g: keyof typeof G; children: ReactNode }) => (
  <li><svg viewBox="0 0 16 16" aria-hidden="true">{G[g]}</svg><span>{children}</span></li>
);

/** Three workers, each in its own VM on its own branch, and the throwaway VM the checks run in; below, the git graph:
 *  each branch leaves the target, runs under its VM and merges back once checks pass; the third is still working and
 *  its last checkpoint sits off the branch, on refs/capcomd/checkpoints/<agent>. */
function Bay() {
  // The graph is drawn on a 1000-unit-wide strip; the four columns' centres are at 125, 375, 625 and 875.
  const MAIN = 100, TOP = 36;
  const loop = (cx: number, done: boolean) => done
    ? `M${cx - 100} ${MAIN}C${cx - 70} ${MAIN} ${cx - 90} ${TOP} ${cx - 60} ${TOP}H${cx + 62}C${cx + 92} ${TOP} ${cx + 72} ${MAIN} ${cx + 102} ${MAIN}`
    : `M${cx - 100} ${MAIN}C${cx - 70} ${MAIN} ${cx - 90} ${TOP} ${cx - 60} ${TOP}H${cx + 34}`;
  const kids: Array<{ i: number; done: boolean }> = [{ i: 1, done: true }, { i: 2, done: true }, { i: 3, done: false }];
  return (
    <figure className="bay" data-reveal style={delay(120)}>
      <div className="bay__row">
        {kids.map(({ i, done }, k) => (
          <div className="bay__vm" key={i} style={{ "--k": k } as CSSProperties}>
            <p className="bay__bar"><span><BoxdMark className="bay__mark" />boxd VM</span><span>worker <code><AgentSuffix i={i} /></code></span></p>
            <Bot i={i} className="bay__bot" mood={done ? "happy" : undefined} pose={done ? "cheer" : undefined} />
            <ul>
              <Line g="key">its own login</Line>
              <Line g="branch">its own branch; the engine pushes it</Line>
              <Line g="net">open network, or the profile&apos;s allowlist</Line>
            </ul>
          </div>
        ))}
        <div className="bay__vm bay__vm--checks" style={{ "--k": 3 } as CSSProperties}>
          <p className="bay__bar"><span><BoxdMark className="bay__mark" />boxd VM</span><span>checks</span></p>
          <p className="bay__checks">Throwaway</p>
          <ul>
            <Line g="nokey">no credentials</Line>
            <Line g="merge">the branch merged with the latest target</Line>
            <Line g="bin">destroyed after</Line>
          </ul>
        </div>
      </div>
      <svg className="bay__git" viewBox={`0 0 1000 ${MAIN + 26}`} aria-hidden="true">
        <path className="bay__main" d={`M0 ${MAIN}H984`} pathLength={1} />
        <path className="bay__tip" d={`M984 ${MAIN - 5}l8 5-8 5z`} />
        <text className="bay__lbl" x={6} y={MAIN + 22}>target</text>
        {kids.map(({ done }, k) => {
          const cx = 125 + k * 250;
          return (
            <g key={k} className={`bay__br${done ? "" : " is-live"}`} style={{ "--k": k } as CSSProperties}>
              <path className="bay__vm-link" d={`M${cx} 0V${TOP - 6}`} />
              <path className="bay__lane" d={loop(cx, done)} pathLength={1} />
              {[-30, 0, 30].map((dx, j) => <circle key={j} className="bay__commit" cx={cx + dx} cy={TOP} r={5} style={{ "--j": j } as CSSProperties} />)}
              {done
                ? <g className="bay__pass"><circle cx={cx + 102} cy={MAIN} r={7} /><path d={`M${cx + 98.5} ${MAIN}l2.5 2.5 4.5-5`} /><text className="bay__lbl" x={cx + 102} y={MAIN + 22} textAnchor="middle">checked, merged</text></g>
                : <g className="bay__ckpt"><path d={`M${cx + 30} ${TOP + 6}V${TOP + 30}`} /><circle cx={cx + 30} cy={TOP + 35} r={5} /><text className="bay__lbl" x={cx + 42} y={TOP + 39}>checkpoint</text></g>}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}


export function Sandboxes() {
  return (
    <section className="sec" id="sandboxes" aria-labelledby="sb-title">
      <h2 className="big" id="sb-title" data-reveal><span>One agent, one VM,</span> <span>one branch.</span></h2>
      <div className="two">
        <p data-reveal>Pick where agents run. boxd gives each agent its own cloud VM, with secrets the agent never sees and an egress allowlist. Docker runs them in containers on your machine with no account to create; isolation is weaker, an API key is visible to the agent, and there is no egress allowlist.</p>
        <p data-reveal style={delay(60)}>Inside its VM an agent is unrestricted by default: every tool, open network. A profile narrows its tools, sandbox and egress.</p>
      </div>
      <Bay />
      <div className="runs" data-reveal style={delay(120)}>
        <h3 className="runs__title">Supported sandboxes</h3>
        <div className="runs__grid">
          <div className="runs__group">
            <p className="runs__kind">Cloud VMs</p>
            <ul className="runs__list">
              <li className="runs__item runs__item--wide"><span className="runs__logo"><BoxdMark className="runs__boxd" /></span><span><b>boxd</b><small>A VM per agent and a throwaway VM for checks; host-bound secrets, an egress allowlist, snapshots.</small></span></li>
            </ul>
          </div>
          <div className="runs__group">
            <p className="runs__kind">Containers on your machine, through the Docker provider</p>
            <ul className="runs__list">
              <li className="runs__item"><span className="runs__logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#2496ED" d={RUNTIME_PATHS.docker} /></svg></span><b>Docker Desktop</b></li>
              <li className="runs__item"><span className="runs__logo"><img src="/logos/orbstack.png" alt="" width={40} height={40} /></span><b>OrbStack</b></li>
              <li className="runs__item"><span className="runs__logo"><img src="/logos/colima.png" alt="" width={40} height={40} /></span><b>Colima</b></li>
              <li className="runs__item"><span className="runs__logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#892CA0" d={RUNTIME_PATHS.podman} /></svg></span><b>Podman</b></li>
            </ul>
            <p className="runs__note">A container, not a VM: no host-bound secrets and no egress allowlist.</p>
          </div>
        </div>
      </div>
      <div className="facts">
        <div data-reveal><h3>Credentials</h3><p>VM snapshots are scrubbed of secrets. An agent&apos;s VM holds only its own login; agents never hold push credentials, and a checks VM holds none.</p></div>
        <div data-reveal style={delay(60)}><h3>Checkpoints</h3><p>The engine pushes each workspace to <code>refs/capcomd/checkpoints/&lt;agent&gt;</code> every 10 minutes, after each commit and at each quarter of a budget, and deletes it once the work merges.</p></div>
        <div data-reveal style={delay(120)}><h3>Continue</h3><p>An agent stopped by a limit ends <code>failed</code> with its work on its branch. <code>spawn --continue agt</code> starts a new agent from that branch, or from the last checkpoint if it crashed or was cancelled.</p></div>
      </div>
    </section>
  );
}
