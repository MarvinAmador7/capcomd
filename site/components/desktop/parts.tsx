// Pieces of the desktop window, rebuilt in HTML from the approved Reel boards at true size (1 CSS px = 1 pt).
// Shared by the hero's reel, the column you operate and the title bar the slider drives.
import { bot, stateText, type Agent, type Line } from "@/lib/desktop";

export const Bot = ({ seed, role, size = "xs", mood, className = "dk-bot" }: { seed: string; role: string; size?: "xs" | "small" | "full"; mood?: "happy" | "sleepy"; className?: string }) => (
  <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: bot(seed, role, size, mood) }} />
);

const paths: Record<string, string> = {
  cloud: "M5 13.5h8.2a3 3 0 0 0 .4-6 4.3 4.3 0 0 0-8.3-.9A3.4 3.4 0 0 0 5 13.5Z",
  laptop: "M3.5 4.5h11v7.5h-11zM1.5 13.5h15",
  eye: "M1.8 9S4.5 4.2 9 4.2 16.2 9 16.2 9 13.5 13.8 9 13.8 1.8 9 1.8 9Zm7.2 2.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z",
  cmd: "M6.5 6.5h5v5h-5zM6.5 6.5V4.8a1.7 1.7 0 1 0-1.7 1.7h1.7Zm5 0V4.8a1.7 1.7 0 1 1 1.7 1.7h-1.7Zm0 5v1.7a1.7 1.7 0 1 0 1.7-1.7h-1.7Zm-5 0v1.7a1.7 1.7 0 1 1-1.7-1.7h1.7Z",
  plus: "M9 3.5v11M3.5 9h11",
  doc: "M5 2.5h5.5L13.5 5.5v10H5zM10.5 2.5v3h3",
  term: "M2.5 3.5h13v11h-13zM5.5 7l2 2-2 2M9 11.5h3.5",
  spawn: "M5 13 13 5M7.5 5H13v5.5",
  check: "M3.5 9.4 7.2 13 14.5 5.2",
  expand: "M10.5 3.5h4v4M14.5 3.5 10 8M7.5 14.5h-4v-4M3.5 14.5 8 10",
  close: "M4.5 4.5l9 9M13.5 4.5l-9 9",
  folder: "M2.5 5h5l1.5 1.5h6.5v7.5h-13z",
  branch: "M5.5 3v12M5.5 6.5a5 5 0 0 0 7 4.5M12.5 4.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
  mic: "M9 2.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0V5A2.5 2.5 0 0 1 9 2.5ZM4.5 8.5a4.5 4.5 0 0 0 9 0M9 13v2.5",
  up: "M9 14.5v-11M4.5 8 9 3.5 13.5 8",
  ret: "M14 4v4.5a2 2 0 0 1-2 2H4.5M7 8 4.5 10.5 7 13",
};
export const Icon = ({ name, size = 15 }: { name: keyof typeof paths | string; size?: number }) => (
  <svg className="dk-ic" viewBox="0 0 18 18" width={size} height={size} aria-hidden="true">
    <path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function ColumnHead({ a, onClose }: { a: Agent; onClose?: boolean }) {
  const st = a.state;
  return (
    <div className="dk-col__head">
      <Bot seed={a.seed} role={a.role} size="small" className="dk-col__bot" />
      <b>{a.role}</b>
      {a.role === "worker" && <span className="dk-id">{a.label}</span>}
      {a.role === "lead" && <span className="dk-id">{a.place}</span>}
      <span className="dk-dim">{a.name}</span>
      <span className={`dk-st dk-st--${st}`}>· {stateText[st]}</span>
      <span className="dk-col__clock">{onClose ? <><Icon name="expand" size={14} /><Icon name="close" size={14} /></> : a.clock}</span>
    </div>
  );
}

export function Thread({ lines, progress }: { lines: Line[]; progress?: number }) {
  return (
    <div className="dk-thread">
      {lines.map((l, i) => {
        switch (l.kind) {
          case "text": return <p key={i} className="dk-msg">{l.text as string}</p>;
          case "tool": return <p key={i} className="dk-tool"><Icon name={l.icon as string} /><span>{l.text as string}</span><span className={l.live ? "dk-t dk-t--live" : "dk-t"}>{l.t as string}</span></p>;
          case "handoff": return <div key={i} className="dk-hand"><p><b>{l.from as string}</b> <span className="dk-dim">handed back</span></p><p>{l.text as string}</p></div>;
          case "log": return <div key={i} className="dk-log">{(l.rows as string[][]).map(([t, s, w]) => <code key={t + s} className={w ? "is-warn" : undefined}><span>{t}</span> {s}</code>)}</div>;
          case "progress": { const done = progress ?? (l.done as number); const of = l.of as number; return <div key={i} className="dk-prog"><p><b>{done}</b> / {of}</p><span><i style={{ width: `${(done / of) * 100}%` }} /></span></div>; }
          case "diff": return (
            <div key={i} className="dk-diff">
              <p className="dk-diff__file"><code>{l.file as string}</code><span><em className="add">+{l.add as number}</em> <em className="del">−{l.del as number}</em></span></p>
              {(l.rows as string[][]).map(([s, t]) => <code key={t} className={s === "+" ? "add" : s === "-" ? "del" : undefined}><span>{s === " " ? "" : s === "-" ? "−" : s}</span>{t}</code>)}
            </div>
          );
          case "check": return <p key={i} className="dk-tool dk-tool--ok"><Icon name="check" /><span>{l.text as string}</span><span className="dk-t">{l.t as string}</span></p>;
          default: return null;
        }
      })}
    </div>
  );
}

/** The decision docked at an asking column's foot (View diff · Deny · Approve ↩). */
export function Decision({ title, sub, onApprove, onDeny, tabIndex }: { title: string; sub: string; onApprove?: () => void; onDeny?: () => void; tabIndex?: number }) {
  return (
    <div className="dk-ask">
      <p className="dk-ask__t">{title}</p>
      <p className="dk-ask__s">{sub}</p>
      <div className="dk-ask__row">
        <span className="dk-dim">View diff</span>
        <button type="button" className="dk-b dk-b--deny" onClick={onDeny} tabIndex={tabIndex}>Deny</button>
        <button type="button" className="dk-b dk-b--ok" onClick={onApprove} tabIndex={tabIndex}>Approve <kbd><Icon name="ret" size={12} /></kbd></button>
      </div>
    </div>
  );
}
