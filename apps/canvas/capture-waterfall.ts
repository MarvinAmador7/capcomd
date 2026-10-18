import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [];
p.on("pageerror", (e) => errors.push(String(e)));
for (const [label, url, node] of [
  ["run-trace", "http://127.0.0.1:43123/?run=run-e2e-1", "run-demo-123"],
  ["task-trace", "http://127.0.0.1:43123/?run=run-e2e-1", "task-1"],
] as const) {
  await p.goto(url);
  await p.waitForTimeout(4500); // demo events finish
  await p.screenshot({ path: `/workspace/relay-shots/canvas-${label}-graph.png` });
  const n = p.locator(`.react-flow__node[data-id="${node}"]`);
  console.log(label, "node count", await n.count());
  await n.first().click({ force: true });
  await p.getByText("View Spans").click();
  await p.waitForSelector('[data-testid="waterfall"]', { timeout: 5000 });
  const rows = await p.locator('[data-testid="waterfall"] [data-kind]').count();
  console.log(label, "waterfall bars", rows);
  await p.screenshot({ path: `/workspace/relay-shots/canvas-${label}-waterfall.png` });
}
console.log("page errors", errors.length, errors.slice(0, 3));
await b.close();
