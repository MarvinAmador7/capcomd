// Fixed identity marks (not generated): the menu bar icon. 1-bit, drawn as a template image ("#" opaque, "." clear),
// so macOS tints it for light and dark menu bars and for the highlighted state.

/**
 * 16×16 menu bar mark (approved by the product owner: variant A, the dome with no antenna): the brand dome head with
 * a visor cut out of it, two eyes and a smile.
 */
export const MENU_BAR_MARK: string[] = [
	"................",
	"................",
	"....########....",
	"..############..",
	".##############.",
	".###........###.",
	".##..##..##..##.",
	".##..##..##..##.",
	".##..........##.",
	".##...####...##.",
	".###........###.",
	".##############.",
	"..############..",
	"...##########...",
	"................",
	"................",
];

/** A 1-bit mark as SVG in one colour (default currentColor), one path, crisp edges. */
export function markSvg(rows: string[], o: { scale?: number; color?: string; label?: string } = {}): string {
	const s = o.scale ?? 1, w = rows[0]!.length, h = rows.length;
	let d = "";
	rows.forEach((r, y) => {
		for (let x = 0; x < w;) {
			if (r[x] !== "#") { x++; continue; }
			let n = 1;
			while (r[x + n] === "#") n++;
			d += `M${x} ${y}h${n}v1h-${n}z`;
			x += n;
		}
	});
	const a11y = o.label ? `role="img" aria-label="${o.label.replace(/[&<>"']/g, "")}"` : `aria-hidden="true"`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * s}" height="${h * s}" shape-rendering="crispEdges" ${a11y}><path fill="${o.color ?? "currentColor"}" d="${d}"/></svg>`;
}
