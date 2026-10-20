/** Render one view of a fixture to a string (no TTY needed). Used by tests and shots. */
import { render } from "ink-testing-library";
import { loadFixture } from "../src/adapters/source";
import { App, type AppProps, type TabKey } from "../src/app";

export async function renderView(fixture: string, tab: TabKey, o: Partial<AppProps> = {}): Promise<string> {
  const data = loadFixture(fixture);
  const r = render(<App data={data} initialTab={tab} width={o.width ?? 132} height={o.height ?? 38} {...o} />);
  await new Promise((res) => setTimeout(res, 30));
  const out = r.lastFrame() ?? "";
  r.unmount();
  return out;
}

if (import.meta.main) {
  const [fixture = "demo-3-tasks", tab = "waterfall"] = Bun.argv.slice(2);
  console.log(await renderView(fixture, tab as TabKey));
}
