import { SITE } from "@/lib/site";
import { Wordmark } from "./marks";


/** The site's navigation. On the home page Start is an anchor; elsewhere it leads back to it. */
export function Nav({ home = true, current }: { home?: boolean; current?: "bots" | "desktop" }) {
  const base = home ? "" : "/";
  return (
    <nav className="nav" aria-label="Main">
      <Wordmark className="nav__mark" />
      <ul className="nav__links m-0 list-none p-0">
        <li><a href={`${base}#start`}>Start</a></li>
        <li><a href="/desktop/" aria-current={current === "desktop" ? "page" : undefined}>Desktop</a></li>
        <li><a href="/bots/" aria-current={current === "bots" ? "page" : undefined}>Bots</a></li>
        <li><a href={SITE.repo}>GitHub</a></li>
      </ul>
      <a className="button" href={`${base}#install`}>Install</a>
    </nav>
  );
}
