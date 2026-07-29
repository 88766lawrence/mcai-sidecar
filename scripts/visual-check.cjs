const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const output = path.resolve(".visual-check");
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(output, `${viewport.name}.png`), fullPage: true });
    const metrics = await page.evaluate(() => ({
      title: document.title,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      h1: document.querySelector("h1")?.textContent,
      topbarVisible: Boolean(document.querySelector(".topbar")?.getBoundingClientRect().height),
    }));
    if (metrics.scrollWidth > metrics.clientWidth) throw new Error(`${viewport.name} has horizontal overflow: ${JSON.stringify(metrics)}`);
    if (!metrics.topbarVisible || metrics.title !== "MCAI Operations") throw new Error(`${viewport.name} failed basic rendering: ${JSON.stringify(metrics)}`);
    console.log(viewport.name, JSON.stringify(metrics));
    await page.close();
  }
  await browser.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
