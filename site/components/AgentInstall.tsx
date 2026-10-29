"use client";

// The install flow (README "Quickstart"): install the CLI, add capcomd to your agent, ask it to set things up.
import { useEffect, useRef, useState } from "react";
import { AGENT_ICONS } from "@/lib/agent-icons";

const ASK = "Set up capcomd for this repository.";
// README "Quickstart", step 1 ("Add capcomd to your agent"), per agent.
const AGENTS = [
  { id: "claude", name: "Claude Code", prompt: "›", copy: "/plugin install capcomd --marketplace MarvinAmador7/capcomd", where: <>Type it in Claude Code. It adds capcomd&apos;s MCP tools and its orchestration and setup skills.</> },
  { id: "codex", name: "Codex", prompt: "$", copy: "codex plugin marketplace add MarvinAmador7/capcomd", where: <>Run it in a terminal, then install capcomd from <code>/plugins</code> in Codex.</> },
  { id: "hermes", name: "Hermes", prompt: "$", copy: "capcomd setup agent", where: <>Run it in your repository, after installing the CLI. It adds capcomd&apos;s MCP server and skills to Hermes.</> },
] as const;

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  try {
    const t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.append(t); t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch { return false; }
}

type AgentId = (typeof AGENTS)[number]["id"];
const PICK = "capcomd:pick-agent";

/** An agent's name with its mark, as a button: picks that agent's tab in the install steps and brings it into view. */
export function AgentPick({ id }: { id: AgentId }) {
  const a = AGENTS.find((x) => x.id === id)!;
  return (
    <button type="button" className="pick" aria-label={`${a.name}: go to its install command`}
      onClick={() => {
        dispatchEvent(new CustomEvent(PICK, { detail: id }));
        const tab = document.querySelector<HTMLElement>(`.hero__install [data-agent="${id}"]`);
        tab?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
        tab?.focus({ preventScroll: true });
      }}>
      <svg viewBox="0 0 24 24" fillRule="evenodd" aria-hidden="true" dangerouslySetInnerHTML={{ __html: AGENT_ICONS[id] }} />
      {a.name}
    </button>
  );
}

/** The hero's compact install row: one button per agent copies that agent's command and says what to do next. Until
 *  the page script runs it keeps its space but stays invisible (no layout shift). */
export function AgentInstall() {
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState<{ id: AgentId; ok: boolean } | null>(null);
  const timer = useRef(0);
  useEffect(() => { setReady(true); return () => clearTimeout(timer.current); }, []);
  const a = done && AGENTS.find((x) => x.id === done.id);
  return (
    <div className={`agents${ready ? "" : " is-waiting"}`} aria-hidden={ready ? undefined : true}>
      <div className="agents__row">
        <span className="agents__lbl">Or copy it for</span>
        {AGENTS.map((x) => (
          <button key={x.id} type="button" data-agent={x.id} className={`agents__btn${done?.id === x.id && done.ok ? " is-done" : ""}`} aria-label={`Copy the ${x.name} command`}
            onClick={async () => { const ok = await copy(x.copy); setDone({ id: x.id, ok }); clearTimeout(timer.current); timer.current = window.setTimeout(() => setDone(null), 9000); }}>
            <svg viewBox="0 0 24 24" fillRule="evenodd" aria-hidden="true" dangerouslySetInnerHTML={{ __html: AGENT_ICONS[x.id] }} />
            <span>{x.name}</span>
          </button>
        ))}
      </div>
      <p className="agents__status" role="status">
        {a ? <><b>{done!.ok ? `Copied for ${a.name}` : `Couldn't copy; for ${a.name}, use`}</b><code>{a.copy}</code>{done!.ok ? <span>{a.where} Then ask: &ldquo;{ASK}&rdquo;</span> : null}</> : null}
      </p>
    </div>
  );
}

/** The README's Quickstart as three rows, each with the exact command to copy and where to run it. Step 2 has a tab
 *  per agent. Without the script the Claude Code row is shown and every command can still be selected. */
export function InstallFlow() {
  const [agent, setAgent] = useState<AgentId>("claude");
  // The agent names in the hero's sentence pick a tab here (AgentPick).
  useEffect(() => {
    const on = (e: Event) => setAgent((e as CustomEvent<AgentId>).detail);
    addEventListener(PICK, on);
    return () => removeEventListener(PICK, on);
  }, []);
  const a = AGENTS.find((x) => x.id === agent)!;
  return (
    <ol className="flow">
      <li className="flow__step">
        <p className="flow__head"><span className="flow__n" aria-hidden="true">1</span><b>Install the CLI</b><small>in a terminal</small></p>
        <InstallCommand cmd="brew install MarvinAmador7/tap/capcomd" label="the install command" />
      </li>
      <li className="flow__step">
        <div className="flow__head">
          <span className="flow__n" aria-hidden="true">2</span><b>Add it to your agent</b>
          <div className="flow__tabs" role="radiogroup" aria-label="Your agent">
            {AGENTS.map((x, k) => (
              <button key={x.id} type="button" role="radio" aria-checked={agent === x.id} tabIndex={agent === x.id ? 0 : -1}
                className={`flow__tab${agent === x.id ? " is-on" : ""}`} data-agent={x.id} onClick={() => setAgent(x.id)}
                onKeyDown={(e) => {
                  const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                  if (!d) return;
                  e.preventDefault();
                  const n = (k + d + AGENTS.length) % AGENTS.length;
                  setAgent(AGENTS[n]!.id);
                  (e.currentTarget.parentElement?.querySelectorAll("button")[n] as HTMLButtonElement | undefined)?.focus();
                }}>
                <svg viewBox="0 0 24 24" fillRule="evenodd" aria-hidden="true" dangerouslySetInnerHTML={{ __html: AGENT_ICONS[x.id] }} />
                <span>{x.name}</span>
              </button>
            ))}
          </div>
        </div>
        <InstallCommand key={a.id} cmd={a.copy} prompt={a.prompt} label={`the ${a.name} command`} />
        <p className="flow__where">{a.where}</p>
      </li>
      <li className="flow__step">
        <p className="flow__head"><span className="flow__n" aria-hidden="true">3</span><b>Ask your agent</b><small>in this repository</small></p>
        <InstallCommand cmd={ASK} prompt="›" label="the request" />
      </li>
    </ol>
  );
}

/** The install command on the page, with a Copy button (the text stays selectable without the script). */
export function InstallCommand({ cmd, prompt = "$", label = "the install command" }: { cmd: string; prompt?: string; label?: string }) {
  const [done, setDone] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const timer = useRef(0);
  useEffect(() => { setReady(true); return () => clearTimeout(timer.current); }, []);
  return (
    <div className="cmd">
      <code className="cmd__text"><span aria-hidden="true">{prompt} </span>{cmd}</code>
      {ready ? (
        <button type="button" className="cmd__copy" aria-label={done ? `Copied ${label}` : `Copy ${label}`}
          onClick={async () => { const ok = await copy(cmd); setDone(ok); clearTimeout(timer.current); timer.current = window.setTimeout(() => setDone(null), 2400); }}>
          {done === null ? "Copy" : done ? "Copied" : "Select it"}
        </button>
      ) : null}
    </div>
  );
}
