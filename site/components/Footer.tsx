import { SITE } from "@/lib/site";
import { Wordmark } from "./marks";

const LINKS: Array<[string, string]> = [
  ["GitHub", SITE.repo],
  ["Status", `${SITE.repo}/blob/main/STATUS.md`],
  ["Roadmap", `${SITE.repo}/blob/main/ROADMAP.md`],
  ["Changelog", `${SITE.repo}/blob/main/CHANGELOG.md`],
  ["Releases", `${SITE.repo}/releases`],
];

export function Footer() {
  return (
    <footer className="grid grid-cols-12 items-start gap-6 bg-surface px-gutter pt-18 pb-14 max-[760px]:block max-[760px]:pt-12 max-[760px]:pb-10">
      <Wordmark className="foot__mark col-span-3 block w-40 text-ink [&_svg]:h-auto [&_svg]:w-full max-[760px]:w-32" />
      <ul className="col-span-3 col-start-5 m-0 grid list-none gap-1.5 p-0 max-[760px]:mt-7">{LINKS.map(([label, href]) => <li key={label}><a href={href}>{label}</a></li>)}</ul>
      <p className="col-span-5 col-start-8 m-0 text-small max-[760px]:mt-7">
        The capcomd name, bots and brand are © 2026 Marvin Amador Campos. capcomd&apos;s code is <a href={`${SITE.repo}/blob/main/LICENSE`}>MIT-licensed</a>. Type: Bebas Neue and EB Garamond, both under the SIL Open Font License (<a href="/fonts/OFL-BebasNeue.txt">Bebas Neue</a>, <a href="/fonts/OFL-EBGaramond.txt">EB Garamond</a>).
      </p>
    </footer>
  );
}
