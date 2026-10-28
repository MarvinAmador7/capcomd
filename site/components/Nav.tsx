import { SITE } from "@/lib/site";
import { Wordmark } from "./marks";

const SECTIONS = [["run", "Run"], ["sandboxes", "Sandboxes"], ["roles", "Roles"], ["scale", "At scale"], ["patterns", "Patterns"]] as const;

/** The site's navigation. On the home page the sections are anchors; elsewhere they lead back to them. */
export function Nav({ home = true, current }: { home?: boolean; current?: "bots" }) {
  const base = home ? "" : "/";
  return (
    <nav className="nav" aria-label="Main">
      <Wordmark className="nav__mark" />
      <ul className="nav__links m-0 list-none p-0">
        {SECTIONS.map(([id, label]) => <li key={id}><a href={`${base}#${id}`}>{label}</a></li>)}
        <li><a href="/bots/" aria-current={current === "bots" ? "page" : undefined}>Bots</a></li>
        <li><a href={SITE.repo}>GitHub</a></li>
      </ul>
      <a className="button" href={`${base}#install`}>Install</a>
    </nav>
  );
}
