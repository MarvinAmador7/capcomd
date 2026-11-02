// Types for title-rules.mjs (plain JS so it can also run in an agent's VM as its naming shim).
export declare const TITLE_WORDS_MAX: number;
export declare const TITLE_MAX_CHARS: number;
export declare const RENAME_WINDOW_MS: number;
export declare const RENAMES_MAX: number;
export declare const INVISIBLE: RegExp;
export declare const SHIM_USAGE: string;
export declare function titleLength(s: string): number;
export declare function cleanTitle(raw: string): string;
export declare function normalizeTitle(raw: unknown): { ok: true; title: string } | { ok: false; error: string };
export declare function renameRefusal(s: { count?: number; last?: Record<string, number> } | null | undefined, setBy: string, what: string, now: number): string | null;
export type ShimState = { title: string; count: number; last: Record<string, number> } | null;
export declare function shimMain(argv: string[], state: ShimState, now: number): { code: number; out: string; state: ShimState };
