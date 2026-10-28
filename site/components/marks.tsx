import type { CSSProperties } from "react";
import { menuMarkSvg, wordmarkSvg } from "@/lib/marks";

/** CSS custom properties for the entrance delays and stagger used by the stylesheet. */
export const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;
export const step = (k: number) => ({ "--k": k }) as CSSProperties;

export function Wordmark({ className, href = "/" }: { className: string; href?: string }) {
  return <a className={className} href={href} aria-label="capcomd home" dangerouslySetInnerHTML={{ __html: wordmarkSvg() }} />;
}

/** The menu bar mark in a strip like macOS's, with a date and a time: decorative chrome above each app panel. */
export function MenuBar() {
  return (
    <div className="menubar" aria-hidden="true">
      <span className="mark"><span dangerouslySetInnerHTML={{ __html: menuMarkSvg("currentColor") }} />1</span>
      <span>Wed 28 Oct</span>
      <span>9:41</span>
    </div>
  );
}

export const MarkFace = () => <span dangerouslySetInnerHTML={{ __html: menuMarkSvg("currentColor") }} />;

export const Check = () => (
  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 6.4 4.8 9 10 3" fill="none" stroke="var(--color-app-green)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export const Hand = () => (
  <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><g fill="var(--color-app-amber)"><rect x="3" y="3" width="2" height="7" rx="1" /><rect x="5.5" y="1.5" width="2" height="8" rx="1" /><rect x="8" y="2.5" width="2" height="7" rx="1" /><rect x="10.3" y="4.5" width="1.8" height="6" rx="0.9" /><rect x="3" y="7" width="9" height="6" rx="3" /></g></svg>
);

/** A small Mac window around a command or a file: the page's native touch. */
export function Win({ title, label, big, children }: { title: string; label: string; big?: boolean; children: React.ReactNode }) {
  return (
    <div className={`win${big ? " win--big" : ""}`} data-ui role="group" aria-label={label}>
      <span className="win__bar" aria-hidden="true"><i /><i /><i /><span>{title}</span></span>
      {children}
    </div>
  );
}
