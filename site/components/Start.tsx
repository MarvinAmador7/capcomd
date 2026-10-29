import { InstallCommand } from "./AgentInstall";
import { delay } from "./marks";
import { Steps } from "./Steps";

// The close's install reprise (README "Quickstart"): the same three steps as the hero, where a reader who scrolled
// the whole page is ready to try it.
export function Start() {
  return (
    <section className="sec start" id="start" aria-labelledby="start-title">
      <h2 className="big" id="start-title" data-reveal><span>Start in</span> <span>three steps.</span></h2>
      <div className="start__body" data-reveal style={delay(80)}>
        <InstallCommand cmd="brew install MarvinAmador7/tap/capcomd" />
        <Steps className="start__steps" />
      </div>
    </section>
  );
}
