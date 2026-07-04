/**
 * colors — the palette. This is the ONE place to restyle the whole CLI:
 * change a code here and every command picks it up. Codes are ANSI SGR
 * (e.g. "32" = green, "38;5;45" = a 256-color foreground).
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

/** Wrap text in an ANSI SGR code (a no-op when color is disabled). */
export const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

/** 256-color foreground helper (used by the banner gradient). */
export const fg256 = (n: number, s: string) => c(`38;5;${n}`, s);

// --- Named styles — tweak these to re-theme -------------------------------
export const bold = (s: string) => c("1", s);
export const dim = (s: string) => c("2", s);
export const green = (s: string) => c("32", s);
export const yellow = (s: string) => c("33", s);
export const red = (s: string) => c("31", s);
export const cyan = (s: string) => c("36", s);
export const blue = (s: string) => c("34", s);
export const magenta = (s: string) => c("35", s);

/** Banner logo gradient, top → bottom (256-color codes: cyan → blue). */
export const BANNER_GRADIENT = [51, 45, 39, 33, 27, 26];
