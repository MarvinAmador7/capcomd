// The pixel CAPCOMD wordmark, redrawn on a cell grid (not copied from the brand files). Used by the build.
// 9 cells tall, 2-cell strokes, chamfered corners. "#" is a filled cell.
const GLYPHS = {
  C: ["..######", ".#######", "###.....", "##......", "##......", "##......", "###.....", ".#######", "..######"],
  A: ["..####..", ".######.", "###..###", "##....##", "##....##", "########", "########", "##....##", "##....##"],
  P: ["#######.", "########", "##....##", "##....##", "########", "#######.", "##......", "##......", "##......"],
  O: ["..####..", ".######.", "###..###", "##....##", "##....##", "##....##", "###..###", ".######.", "..####.."],
  M: ["###....###", "####..####", "##.####.##", "##..##..##", "##......##", "##......##", "##......##", "##......##", "##......##"],
  D: ["######..", "#######.", "##...###", "##....##", "##....##", "##....##", "##...###", "#######.", "######.."],
};

export function wordmarkSvg({ word = "CAPCOMD", gap = 2, label = "capcomd" } = {}) {
  let x0 = 0, d = "";
  for (const ch of word) {
    const g = GLYPHS[ch];
    g.forEach((row, y) => {
      for (let x = 0; x < row.length;) {
        if (row[x] !== "#") { x++; continue; }
        let n = 1;
        while (row[x + n] === "#") n++;
        d += `M${x0 + x} ${y}h${n}v1h-${n}z`;
        x += n;
      }
    });
    x0 += g[0].length + gap;
  }
  const w = x0 - gap;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 9" shape-rendering="crispEdges" role="img" aria-label="${label}"><path fill="currentColor" d="${d}"/></svg>`;
}
