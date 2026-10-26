// Link targets and media sources: every class, the rejections (javascript:, data:, svg), path traversal, credentials
// and text/href mismatch.
import { describe, expect, test } from "bun:test";
import { checkImage, classifyLink, resolveMedia, workspacePath, type LinkContext } from "../src/index";

const ctx: LinkContext = { root: "/w/repo", attachment: (id) => (id === "att-00000000000000000000aaaa" ? { mime: "video/mp4", bytes: 1234 } : null) };
const link = (href: string, text = "t") => classifyLink(href, text, ctx);

describe("link targets", () => {
	test("web: http(s) only, credentials removed, host shown", () => {
		expect(link("https://user:tok@Example.com:8443/a?b=1#c")).toEqual({ t: "link", text: "t", href: "https://example.com:8443/a?b=1#c", target: "web", host: "example.com:8443", id: null, path: null, mismatch: false });
		expect(link("HTTP://x.dev").target).toBe("web");
		expect(link("ftp://x.dev").target).toBe("none");
	});
	test("artifact, agent, run ids", () => {
		expect(link("att-0123456789abcdef").target).toBe("artifact");
		expect(link("attachment:att-0123456789abcdef").id).toBe("att-0123456789abcdef");
		expect(link("agt-4423")).toMatchObject({ target: "agent", id: "agt-4423" });
		expect(link("capcomd://run/run-17-abc")).toMatchObject({ target: "run", id: "run-17-abc" });
	});
	test("file: relative or under the workspace root, normalized", () => {
		expect(link("./src/../src/a.ts#L3")).toMatchObject({ target: "file", path: "src/a.ts", href: "src/a.ts" });
		expect(link("/w/repo/docs/x.md")).toMatchObject({ target: "file", path: "docs/x.md" });
		expect(link("file:///w/repo/a%20b.txt")).toMatchObject({ target: "file", path: "a b.txt" });
	});
	test("none: scripts, data, mail, custom schemes, and nothing to follow", () => {
		for (const h of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>", "vbscript:x", "mailto:a@b.c", "r2://bucket/x", "slack://open", "//evil.com/x", "", "~/.ssh/id_rsa"])
			expect([h, link(h, "x")]).toEqual([h, { t: "link", text: "x", href: null, target: "none", host: null, id: null, path: null, mismatch: false }]);
	});
	test("path traversal never escapes the workspace", () => {
		for (const h of ["../secret", "a/../../b", "%2e%2e/%2e%2e/etc/passwd", "/etc/passwd", "/w/repo-other/x", "/w/repo/../x", "file:///etc/passwd", "a\\..\\..\\b", ".git/config", "src/.git/hooks/x", "a%00b"])
			expect([h, link(h).target]).toEqual([h, "none"]);
		expect(workspacePath("/w/repo/", "/w/repo")).toBeNull();
	});
	test("mismatch: the text names another host (or a URL for a non-web target)", () => {
		expect(link("https://evil.example.com/login", "github.com").mismatch).toBe(true);
		expect(link("https://evil.example.com/login", "https://github.com/login").mismatch).toBe(true);
		expect(link("https://www.github.com/x", "github.com").mismatch).toBe(false);
		expect(link("https://github.com/x", "the docs").mismatch).toBe(false);
		expect(link("report.md", "https://github.com/report.md").mismatch).toBe(true);
	});
});

describe("media sources", () => {
	test("workspace, remote, attachment; kind and type from the extension or the attachment", () => {
		expect(resolveMedia("charts/a.png", "chart", ctx)).toEqual({ t: "media", kind: "image", source: { type: "workspace", path: "charts/a.png" }, alt: "chart", mime: "image/png", bytes: null, width: null, height: null });
		expect(resolveMedia("https://u:p@cdn.example.com/v.webm", "v", ctx)).toMatchObject({ kind: "video", source: { type: "remote", url: "https://cdn.example.com/v.webm", host: "cdn.example.com" } });
		expect(resolveMedia("att-00000000000000000000aaaa", "clip", ctx)).toMatchObject({ kind: "video", source: { type: "attachment", id: "att-00000000000000000000aaaa" }, mime: "video/mp4", bytes: 1234 });
		expect(resolveMedia("docs/spec.pdf", "spec", ctx)).toMatchObject({ kind: "file", source: { type: "workspace", path: "docs/spec.pdf" } });
	});
	test("rejected: data:, javascript:, svg, outside the workspace → a link the client shows as text (or a web link for svg)", () => {
		expect(resolveMedia("data:image/png;base64,iVBORw0KGgo=", "px", ctx)).toMatchObject({ t: "link", target: "none", text: "px" });
		expect(resolveMedia("javascript:alert(1)", "", ctx)).toMatchObject({ t: "link", target: "none", text: "image" });
		expect(resolveMedia("../../x.png", "x", ctx)).toMatchObject({ t: "link", target: "none" });
		expect(resolveMedia("https://cdn.example.com/logo.svg", "logo", ctx)).toMatchObject({ t: "link", target: "web" });
		expect(resolveMedia("logo.svg", "logo", ctx)).toMatchObject({ t: "media", kind: "file" });
	});
	test("tool images: allowlisted by their bytes, svg and lies rejected, size capped", () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		expect(checkImage(png)).toMatchObject({ mime: "image/png", width: 1, height: 1, bytes: 70 });
		expect(checkImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64"))).toEqual({ rejected: "not a png, jpeg, gif or webp image" });
		expect(checkImage("not base64!")).toEqual({ rejected: "not base64" });
		expect(checkImage(Buffer.alloc(6 * 1024 * 1024).toString("base64"))).toMatchObject({ rejected: expect.stringContaining("larger than") });
	});
});
