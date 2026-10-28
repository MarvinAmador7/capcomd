// Types for the parts of packages/bot-avatar the site uses (see packages/bot-avatar/src for the full API).
export type Size = "xs" | "small" | "full";
export interface BotTraits { seed: string; role: string; name: string; [slot: string]: string }
export interface AvatarInput {
  seed: string; role?: string | null; size: Size; scale?: number; label?: string; decorative?: boolean;
  mood?: "happy" | "sleepy" | "oops" | "love"; pose?: string; accessory?: string; traits?: BotTraits;
}
export function botSvg(input: AvatarInput): string;
export function botTeam(members: Array<{ seed: string; role?: string | null }>): BotTraits[];
export function h32(s: string): number;
export const MENU_BAR_MARK: string[];
export function markSvg(rows: string[], o?: { scale?: number; color?: string; label?: string }): string;
