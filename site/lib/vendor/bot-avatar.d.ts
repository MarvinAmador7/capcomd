// Types for packages/bot-avatar as vendored in bot-avatar.js (see packages/bot-avatar/src for the source and docs).
export type Role = "planner" | "lead" | "worker" | "critic" | "other";
export type Size = "xs" | "small" | "full";
export type Slot = "palette" | "antenna" | "accessory" | "head" | "ears" | "screen" | "eyes" | "mouth" | "blush" | "torso" | "plate" | "pose" | "legs" | "dither" | "name";
export type PartSlot = Exclude<Slot, "name">;
export type Mood = "happy" | "sleepy" | "oops" | "love";

export interface Part {
  id: string; label: string; weight?: number; roles?: Partial<Record<Role, number>>; occupies?: string[];
  requires?: Partial<Record<Slot, string[]>>; excludes?: Partial<Record<Slot, string[]>>; keep?: boolean;
  colors?: Record<string, string>; style?: "flat" | "checker" | "bayer" | "scan";
}
export interface Catalog {
  format: "bot-catalog/1";
  frames: Record<Size, { w: number; h: number; outline: boolean; shadow: boolean }>;
  constants: Record<string, string>;
  slots: Record<PartSlot, Part[]>;
  names: string[];
  bayer4: number[][];
}
export interface BotTraits {
  format: "bot/1"; seed: string; role: Role; name: string;
  palette: string; antenna: string; accessory: string; head: string; ears: string; screen: string; eyes: string;
  mouth: string; blush: string; torso: string; plate: string; pose: string; legs: string; dither: string;
}
export interface BotGrid { w: number; h: number; palette: string[]; px: number[] }
export interface AvatarInput {
  seed: string; role?: string | null; size: Size; scale?: number; label?: string; decorative?: boolean;
  mood?: Mood; pose?: string; accessory?: string; traits?: BotTraits;
}

export const CATALOG: Catalog;
export const ROLES: readonly Role[];
export const SIZES: readonly Size[];
export const SLOTS: readonly Slot[];
export const MOODS: Record<Mood, { eyes: string; mouth: string }>;
export const MENU_BAR_MARK: string[];
export function botTraits(seed: string, role?: string | null): BotTraits;
export function botTeam(members: Array<{ seed: string; role?: string | null }>): BotTraits[];
export function botGrid(traits: BotTraits, size: Size): BotGrid;
export function botSvg(input: AvatarInput): string;
export function gridSvg(g: BotGrid, o: { scale?: number; label: string; decorative?: boolean }): string;
export function withPart(t: BotTraits, slot: PartSlot, id: string): BotTraits;
export function withOverrides(t: BotTraits, o?: { mood?: Mood; pose?: string; accessory?: string }): BotTraits;
export function compatible(cand: Part, slot: Slot, chosen: Array<[Slot, Part]>): boolean;
export function candidates(slot: PartSlot, role: Role, chosen: Array<[Slot, Part]>): Part[];
export function weightOf(part: Part, role: Role): number;
export function normalizeRole(role?: string | null): Role;
export function countCombinations(role: Role): number;
export function botName(seed: string): string;
export function h32(s: string): number;
export function hkey(...parts: Array<string | number>): number;
export function artFor(p: Part, size: Size): unknown;
export function tone(lx: number, ly: number, w: number, h: number, x: number, y: number, style: "flat" | "checker" | "bayer" | "scan", bayer: number[][]): 0 | 1 | 2;
export function rng(seed: string, stream: string): () => number;
export function markSvg(rows: string[], o?: { scale?: number; color?: string; label?: string }): string;
