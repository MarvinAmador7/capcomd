import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { join } from "path";

async function captureScreenshots() {
  const screenshotsDir = join(process.cwd(), "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();

  console.log("Loading canvas...");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

  await page.waitForTimeout(3000);

  console.log("Capturing full canvas view...");
  await page.screenshot({
    path: join(screenshotsDir, "canvas-full-view.png"),
    fullPage: false,
  });

  console.log("Clicking a task node...");
  await page.click('div[data-id="task-1"]');
  await page.waitForTimeout(1000);

  console.log("Capturing node details panel...");
  await page.screenshot({
    path: join(screenshotsDir, "canvas-node-details.png"),
    fullPage: false,
  });

  console.log("Switching to live mode...");
  await page.click('button:has-text("Live Mode")');
  await page.waitForTimeout(1000);

  console.log("Capturing live mode...");
  await page.screenshot({
    path: join(screenshotsDir, "canvas-live-mode.png"),
    fullPage: false,
  });

  console.log("Clicking replay mode...");
  await page.click('button:has-text("Replay Mode")');
  await page.waitForTimeout(1000);

  console.log("Capturing timeline scrubber...");
  await page.screenshot({
    path: join(screenshotsDir, "canvas-timeline.png"),
    fullPage: false,
  });

  await browser.close();

  console.log("\n✓ Screenshots saved to screenshots/");
  console.log("  - canvas-full-view.png");
  console.log("  - canvas-node-details.png");
  console.log("  - canvas-live-mode.png");
  console.log("  - canvas-timeline.png");
}

captureScreenshots().catch(console.error);
