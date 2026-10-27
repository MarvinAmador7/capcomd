// Catalog and output types. The catalog is plain data (exported as fixtures/catalog.json for other languages).

export const ROLES = ["planner", "lead", "worker", "critic", "other"] as const;
export type Role = (typeof ROLES)[number];

export const SIZES = ["xs", "small", "full"] as const;
export type Size = (typeof SIZES)[number];

/** Slots in pick order. A slot's candidates are filtered by the parts already picked for earlier slots. */
export const SLOTS = ["palette", "antenna", "accessory", "head", "ears", "screen", "eyes", "mouth", "blush", "torso", "plate", "pose", "legs", "dither", "name"] as const;
export type Slot = (typeof SLOTS)[number];

/** A point [x, y] in cells. */
export type Pt = [number, number];

/**
 * Pixel art: one string per row, one character per cell. "." is empty; every other character is a colour slot
 * (see PIXEL_KEYS). `anchor` is the point of this sprite that lands on its host's anchor.
 */
export interface Art {
	rows: string[];
	anchor?: Pt;
	/** Named points other parts attach to (heads: top, side, earL, earR, neck, visor; torsos: neck, armL, armR, hip, plate). */
	anchors?: Record<string, Pt>;
}

/** Drawings per detail level. `std` is used for both small and full when they have no drawing of their own. */
export interface Levels {
	xs?: Art;
	std?: Art;
	small?: Art;
	full?: Art;
}

export interface Part {
	id: string;
	label: string;
	/** Integer weight (default 4). */
	weight?: number;
	/** Integer weight per role, overriding `weight`; 0 means never for that role. */
	roles?: Partial<Record<Role, number>>;
	/** Zones this part takes up; two parts that share a zone never combine. */
	occupies?: string[];
	/** Only combine with these parts of another slot. */
	requires?: Partial<Record<Slot, string[]>>;
	/** Never combine with these parts of another slot. */
	excludes?: Partial<Record<Slot, string[]>>;
	art?: Levels;
	/** A trait a moment's override must never remove (the orchestrators' crown and flag). */
	keep?: boolean;
	/** Head anchor an accessory attaches to (default "top"). */
	attach?: string;
	/** For palettes and screens: colour slot → hex. */
	colors?: Record<string, string>;
	/** For screens: colours that replace `colors` at xs, where there is no bezel to separate a light screen. */
	colorsXs?: Record<string, string>;
	/** For poses: [left arm, right arm], each drawn as a right arm anchored at the shoulder (the left is mirrored). */
	arms?: [Art, Art];
	/** For dither styles. */
	style?: DitherStyle;
}

export type DitherStyle = "flat" | "checker" | "bayer" | "scan";

export interface Frame {
	w: number;
	h: number;
	/** Where the head's top-left cell goes. */
	head: Pt;
	/** Draw a one-cell ink outline around the silhouette. */
	outline: boolean;
	/** Draw a dithered ground shadow under the feet (full body). */
	shadow: boolean;
	/** Which drawing a part uses at this level. */
	uses: Array<keyof Levels>;
	/** Shading at this level ("auto" = the bot's dither style; xs is always flat). */
	shading: "auto" | "flat";
}

export interface Catalog {
	format: "bot-catalog/1";
	frames: Record<Size, Frame>;
	/** Fixed colours shared by every palette (metal, ink, flame, white, shadow). */
	constants: Record<string, string>;
	slots: Record<Exclude<Slot, "name">, Part[]>;
	names: string[];
	/** 4×5 glyphs for the letter chest plate, "#" = ink. */
	glyphs: Record<string, string[]>;
	/** The dithered ground shadow under a full-body bot ("S" cells), anchored at the canvas's bottom centre. */
	ground?: Art;
	/** 4×4 ordered-dither thresholds 0–15, indexed [y & 3][x & 3]. */
	bayer4: number[][];
}

export interface BotTraits {
	format: "bot/1";
	seed: string;
	role: Role;
	name: string;
	palette: string;
	antenna: string;
	accessory: string;
	head: string;
	ears: string;
	screen: string;
	eyes: string;
	mouth: string;
	blush: string;
	torso: string;
	plate: string;
	pose: string;
	legs: string;
	dither: string;
}

/** A rendered bot: w×h cells, each -1 (empty) or an index into `palette` (hex "#RRGGBB" or "#RRGGBBAA"). */
export interface BotGrid {
	w: number;
	h: number;
	palette: string[];
	px: number[];
}
