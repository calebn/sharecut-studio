/**
 * Renders the Home Screen icons in public/assets/app/ from icon.svg:
 * apple-touch-icon.png (180 px, iOS) and icon-192.png / icon-512.png (the web
 * app manifest). Run it after editing icon.svg:
 *   npx vite-node scripts/render-app-icons.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const dir = path.join(import.meta.dirname, "../public/assets/app");
const svg = readFileSync(path.join(dir, "icon.svg"), "utf8");
const OUTPUTS = [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
] as const;

const browser = await chromium.launch();
try {
  for (const [name, size] of OUTPUTS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    const sized = svg.replace(
      "<svg ",
      `<svg style="display:block;width:${size}px;height:${size}px" `,
    );
    await page.setContent(`<body style="margin:0">${sized}</body>`);
    await page.screenshot({ path: path.join(dir, name) });
    await page.close();
  }
} finally {
  await browser.close();
}
