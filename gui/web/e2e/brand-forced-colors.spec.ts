import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { openHome } from "./home";

const splashUrl = pathToFileURL(
  fileURLToPath(new URL("../../desktop/splash/index.html", import.meta.url)),
).href;

async function markFills(page: Page, selector: string) {
  return page.evaluate((markSelector) => {
    const probe = document.createElement("span");
    probe.style.color = "CanvasText";
    document.body.append(probe);
    const canvasText = getComputedStyle(probe).color;
    probe.remove();
    const fills = [
      ...document.querySelectorAll<SVGPathElement>(markSelector),
    ].map((path) => getComputedStyle(path).fill);
    return { canvasText, fills };
  }, selector);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`brand marks under forced colors, ${colorScheme} palette`, () => {
    test.use({ forcedColors: "active", colorScheme });

    test("the desktop splash mark takes the system text colour", async ({
      page,
    }) => {
      await page.goto(splashUrl);
      const { canvasText, fills } = await markFills(page, ".mark path");
      expect(fills.length).toBeGreaterThan(0);
      expect(new Set(fills)).toEqual(new Set([canvasText]));
    });

    test("the home screen lockup takes the system text colour", async ({
      page,
    }) => {
      await openHome(page);
      const { canvasText, fills } = await markFills(page, ".brand-lockup path");
      expect(fills.length).toBeGreaterThan(0);
      expect(new Set(fills)).toEqual(new Set([canvasText]));
    });
  });
}

test.describe("brand marks outside forced colors", () => {
  test.use({ forcedColors: "none", colorScheme: "dark" });

  test("the splash mark keeps its brand colours", async ({ page }) => {
    await page.goto(splashUrl);
    const { canvasText, fills } = await markFills(page, ".mark path");
    expect(new Set(fills).size).toBe(2);
    expect(fills).not.toContain(canvasText);
  });
});
