import "server-only";

/** A Google Fonts face as TrueType (what next/og's renderer reads), fetched at build time. */
export async function googleFont(family: string, weight = 400): Promise<ArrayBuffer> {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}`)).text();
  const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
  if (!url) throw new Error(`no TrueType source for ${family}`);
  return (await fetch(url)).arrayBuffer();
}
