"use client";

// One button per coding agent that copies the README's "add capcomd to your agent" step for it (Quickstart, step 1),
// and says what to do next. Until the page script runs the row keeps its space but stays invisible (no layout shift);
// the README link beside it works either way.
import { useEffect, useRef, useState } from "react";
import { AGENT_ICONS } from "@/lib/agent-icons";

const ASK = "Set up capcomd for this repository.";
const AGENTS = [
  { id: "claude", name: "Claude Code", copy: "/plugin install capcomd --marketplace MarvinAmador7/capcomd", next: <>Paste it into Claude Code, then ask: &ldquo;{ASK}&rdquo;</> },
  { id: "codex", name: "Codex", copy: "codex plugin marketplace add MarvinAmador7/capcomd", next: <>Run it in a terminal, install capcomd from <code>/plugins</code> in Codex, then ask: &ldquo;{ASK}&rdquo;</> },
  { id: "hermes", name: "Hermes", copy: "curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh && capcomd setup agent", next: <>Run it in your repository, then ask Hermes: &ldquo;{ASK}&rdquo;</> },
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

export function AgentInstall() {
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState<{ id: string; ok: boolean } | null>(null);
  const timer = useRef(0);
  useEffect(() => { setReady(true); return () => clearTimeout(timer.current); }, []);
  const a = done && AGENTS.find((x) => x.id === done.id);
  return (
    <div className={`agents${ready ? "" : " is-waiting"}`} aria-hidden={ready ? undefined : true}>
      <div className="agents__row">
        <span className="agents__lbl">Copy the install for</span>
        {AGENTS.map((x) => (
          <button key={x.id} type="button" className={`agents__btn${done?.id === x.id && done.ok ? " is-done" : ""}`} aria-label={`Copy the install command for ${x.name}`} data-tip={x.name}
            onClick={async () => { const ok = await copy(x.copy); setDone({ id: x.id, ok }); clearTimeout(timer.current); timer.current = window.setTimeout(() => setDone(null), 9000); }}>
            <svg viewBox="0 0 24 24" fillRule="evenodd" aria-hidden="true" dangerouslySetInnerHTML={{ __html: AGENT_ICONS[x.id] }} />
          </button>
        ))}
      </div>
      <p className="agents__status" role="status">
        {a ? <><b>{done!.ok ? `Copied for ${a.name}` : `Couldn't copy; for ${a.name}, use`}</b><code>{a.copy}</code>{done!.ok ? <span>{a.next}</span> : null}</> : null}
      </p>
    </div>
  );
}
