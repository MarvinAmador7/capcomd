// Agent text before it is parsed or shown: terminal escapes and control characters out, line ends normalized,
// Unicode in NFC. Bidi override/isolate controls are removed too (they make text read differently from what it is).

// CSI (ESC [ … final), OSC (ESC ] … BEL or ESC \), other two-character ESC sequences, and 8-bit CSI.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// C0 and C1 controls except tab and newline, DEL, and the bidi embedding/override/isolate controls.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// `scheme://user:secret@host`: credentials in a URL, anywhere in the text (prose, code, tool output).
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

export function sanitize(s: string): string {
	return s.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "").replace(URL_CREDENTIALS, "$1").normalize("NFC");
}

/** One line: sanitized, whitespace collapsed, at most `max` characters (an ellipsis when cut). */
export function oneLine(s: unknown, max = 200): string {
	const t = sanitize(typeof s === "string" ? s : s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** At most `max` UTF-8 bytes of `s`, cut at a character boundary. */
export function capBytes(s: string, max: number): string {
	if (utf8Bytes(s) <= max) return s;
	return Buffer.from(s, "utf8").subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "");
}

/** The last `max` UTF-8 bytes of `s` (for tool output, where the end matters). */
export function tailBytes(s: string, max: number): string {
	const b = Buffer.from(s, "utf8");
	if (b.length <= max) return s;
	return b.subarray(b.length - max).toString("utf8").replace(/^\uFFFD+/, "");
}
