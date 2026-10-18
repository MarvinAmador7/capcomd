import { chromium } from "playwright";

async function capture() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  
  console.log("Loading canvas...");
  await page.goto("http://localhost:3001", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  
  console.log("1. Capturing full graph view...");
  await page.screenshot({
    path: "/workspace/artifacts/relay-canvas-graph.png",
    fullPage: false,
  });
  
  // Try to click a task node
  console.log("2. Trying to click a task node...");
  const taskNode = await page.$('text="Task task-1"');
  if (taskNode) {
    await taskNode.click();
    await page.waitForTimeout(1000);
    
    console.log("3. Capturing with details panel...");
    await page.screenshot({
      path: "/workspace/artifacts/relay-canvas-details.png",
      fullPage: false,
    });
  }
  
  // Capture timeline
  console.log("4. Capturing timeline view...");
  await page.screenshot({
    path: "/workspace/artifacts/relay-canvas-timeline.png",
    fullPage: true,
  });
  
  // Try clicking Live Mode
  console.log("5. Trying live mode...");
  const liveButton = await page.$('text="Live Mode"');
  if (liveButton) {
    await liveButton.click();
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: "/workspace/artifacts/relay-canvas-live.png",
      fullPage: false,
    });
  }
  
  await browser.close();
  console.log("\n✓ Screenshots saved to /workspace/artifacts/");
}

capture().catch(console.error);
