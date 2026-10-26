// Where a link or an image points, classified by the daemon so a client never follows agent-written URLs blindly.
// web: http(s) only, credentials removed. artifact: an attachment the daemon holds. file: a path inside the agent's
// workspace (relative, normalized, never escaping it). agent / run: capcomd ids. none: everything else.
import type { LinkNode, MediaBlock } from "./schema";
import { oneLine } from "./sanitize";

/** What the classifier may know about the agent's world. Lookups are injected (pure here). */
export interface LinkContext {
	/** Absolute path of the agent's workspace (its checkout in the VM): absolute paths under it become relative file links. */
	root?: string | null;
	/** An attachment the daemon holds, for its media type and size; null when unknown. */
	attachment?: (id: string) => { mime: string; bytes: number; width?: number | null; height?: number | null } | null;
}

const ATT = /^(?:attachment:)?(att-[0-9a-f]{8,64})$/;
const AGENT = /^(?:capcomd:\/\/agent\/)?(agt-[A-Za-z0-9_-]{1,100})$/;
const RUN = /^(?:capcomd:\/\/run\/)?(run-[A-Za-z0-9_-]{1,100})$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

const MEDIA_EXT: Record<string, { kind: MediaBlock["kind"]; mime: string }> = {
	png: { kind: "image", mime: "image/png" }, jpg: { kind: "image", mime: "image/jpeg" }, jpeg: { kind: "image", mime: "image/jpeg" },
	gif: { kind: "image", mime: "image/gif" }, webp: { kind: "image", mime: "image/webp" }, avif: { kind: "image", mime: "image/avif" },
	mp4: { kind: "video", mime: "video/mp4" }, m4v: { kind: "video", mime: "video/mp4" }, mov: { kind: "video", mime: "video/quicktime" }, webm: { kind: "video", mime: "video/webm" },
	mp3: { kind: "audio", mime: "audio/mpeg" }, m4a: { kind: "audio", mime: "audio/mp4" }, wav: { kind: "audio", mime: "audio/wav" },
	ogg: { kind: "audio", mime: "audio/ogg" }, oga: { kind: "audio", mime: "audio/ogg" }, flac: { kind: "audio", mime: "audio/flac" },
};
/** A path's media kind and type by extension; null for anything else (svg included: it is never media here). */
export function mediaOfPath(p: string): { kind: MediaBlock["kind"]; mime: string } | null {
	const m = /\.([A-Za-z0-9]{1,5})$/.exec(p.replace(/[?#].*$/, ""));
	return m ? MEDIA_EXT[m[1]!.toLowerCase()] ?? null : null;
}
const kindOfMime = (mime: string): MediaBlock["kind"] =>
	/^image\/(png|jpeg|gif|webp|avif)$/.test(mime) ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

/** An http(s) URL without credentials, or null. */
export function webUrl(href: string): URL | null {
	let u: URL;
	try { u = new URL(href); } catch { return null; }
	if (u.protocol !== "http:" && u.protocol !== "https:") return null;
	u.username = ""; u.password = "";
	return u;
}

/**
 * A path inside the workspace, relative and normalized ('/'-separated, no `.`, `..` or empty segments), or null when
 * it is outside it, absolute outside `root`, under .git, or not a plain path.
 */
export function workspacePath(raw: string, root?: string | null): string | null {
	let p = raw.replace(/[?#].*$/, "");
	try { p = decodeURIComponent(p); } catch { return null; }
	if (!p || /[\u0000\\]/.test(p) || p.startsWith("~")) return null;
	if (p.startsWith("/")) {
		const r = root ? root.replace(/\/+$/, "") : null;
		if (!r || !(p === r || p.startsWith(`${r}/`))) return null;
		p = p.slice(r.length);
	}
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") { if (!out.length) return null; out.pop(); continue; }
		if (seg === ".git") return null;
		out.push(seg);
	}
	return out.length ? out.join("/") : null;
}

/** A link text that names a URL or host ("example.com", "https://x.dev/a"): its host, lowercased; else null. */
export function hostInText(text: string): string | null {
	const t = text.trim();
	if (!t || /\s/.test(t)) return null;
	const withScheme = SCHEME.test(t) ? t : /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(t) ? `https://${t}` : null;
	if (!withScheme) return null;
	try { const u = new URL(withScheme); return u.host ? u.host.toLowerCase() : null; } catch { return null; }
}
const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

const none = (text: string): LinkNode => ({ t: "link", text, href: null, target: "none", host: null, id: null, path: null, mismatch: false });

/** Classify one link. `text` is what the agent showed for it (already plain text). */
export function classifyLink(href: string, text: string, ctx: LinkContext = {}): LinkNode {
	const h = href.trim();
	const shown = text || h;
	const textHost = hostInText(shown);
	const mk = (o: Partial<LinkNode> & Pick<LinkNode, "href" | "target" | "mismatch">): LinkNode =>
		({ t: "link", text: shown, href: o.href, target: o.target, host: o.host ?? null, id: o.id ?? null, path: o.path ?? null, mismatch: o.mismatch });
	const web = SCHEME.test(h) && /^https?:/i.test(h) ? webUrl(h) : null;
	if (web) return mk({ href: web.href, target: "web", host: web.host, mismatch: !!textHost && textHost !== web.host.toLowerCase() && bare(textHost) !== bare(web.host) && shown !== h });
	let m: RegExpExecArray | null;
	const named = (target: "artifact" | "agent" | "run", id: string): LinkNode => mk({ href: id, target, id, mismatch: !!textHost });
	if ((m = ATT.exec(h))) return named("artifact", m[1]!);
	if ((m = AGENT.exec(h))) return named("agent", m[1]!);
	if ((m = RUN.exec(h))) return named("run", m[1]!);
	const scheme = SCHEME.exec(h)?.[1]?.toLowerCase();
	const pathPart = scheme === "file" ? h.replace(/^file:(\/\/[^/]*)?/i, "") : scheme ? null : h;
	const path = pathPart !== null && !pathPart.startsWith("//") ? workspacePath(pathPart, ctx.root) : null;
	if (path) return mk({ href: path, target: "file", path, mismatch: !!textHost });
	return none(shown);
}

/**
 * `![alt](src)` or a bare link to media: a media block (attachment, workspace or remote source), or, when it resolves
 * to nothing the client may load (data:, javascript:, svg, outside the workspace), a link with target none or web.
 */
export function resolveMedia(src: string, alt: string, ctx: LinkContext = {}): MediaBlock | LinkNode {
	const s = src.trim();
	const altText = oneLine(alt, 500);
	const block = (kind: MediaBlock["kind"], source: MediaBlock["source"], mime: string | null, extra: Partial<MediaBlock> = {}): MediaBlock =>
		({ t: "media", kind, source, alt: altText, mime, bytes: null, width: null, height: null, ...extra });
	const link = classifyLink(s, altText || s, ctx);
	if (link.target === "web") {
		const u = webUrl(s)!;
		const m = mediaOfPath(u.pathname);
		// An svg (or anything that isn't media) stays a link: remote media is only what a client may show on a click.
		if (!m && /\.svgz?$/i.test(u.pathname)) return link;
		return block(m?.kind ?? "image", { type: "remote", url: u.href, host: u.host }, m?.mime ?? null);
	}
	if (link.target === "artifact") {
		const info = ctx.attachment?.(link.id!) ?? null;
		return block(info ? kindOfMime(info.mime) : "image", { type: "attachment", id: link.id! }, info?.mime ?? null,
			info ? { bytes: info.bytes, width: info.width ?? null, height: info.height ?? null } : {});
	}
	if (link.target === "file") {
		const m = mediaOfPath(link.path!);
		return block(m?.kind ?? "file", { type: "workspace", path: link.path! }, m?.mime ?? null);
	}
	return none(altText || "image");
}
