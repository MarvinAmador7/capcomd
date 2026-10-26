// How a fixture session becomes its golden file: a fixed clock, a fixed id prefix, the fixture workspace root and one
// known attachment, so the output depends only on the session and the code.
import { threadBuilder, type Cli, type ItemDraft, type StoredImage } from "../src/index";

export const GOLDEN_ROOT = "/home/user/work/t1-e1/repo";
export const GOLDEN_ATTACHMENT = { id: "att-0123456789abcdef01234567", mime: "image/png", bytes: 68, width: 1, height: 1 };
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);

export function goldenOf(file: string, jsonl: string) {
	const cli: Cli = file.startsWith("codex") ? "codex" : "claude";
	let t = T0;
	const images: Array<Omit<StoredImage, "base64" | "sha256">> = [];
	const b = threadBuilder({
		cli, idPrefix: "itm-agt-golden", now: () => t,
		link: { root: GOLDEN_ROOT, attachment: (id) => (id === GOLDEN_ATTACHMENT.id ? GOLDEN_ATTACHMENT : null) },
		onImage: ({ base64: _b, sha256: _s, ...img }) => images.push(img),
	});
	const updates: ItemDraft[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		t += 1000;
		updates.push(...b.event(JSON.parse(line)));
	}
	updates.push(...b.finish());
	return { session: file, cli, updates, attachments: images };
}
