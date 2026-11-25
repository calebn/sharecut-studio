import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { expectFeedback } from "./feedback";
import { expectNoHorizontalScroll, expectTouchTargets } from "./modelsMock";
import { openPhoneTimeline } from "./phoneTimeline";
import { setRootFontSize } from "./rootFontSize";
import { openProject, openToolsIfFolded } from "./stageNav";
import { setTheme, type Theme, withAppearance } from "./theme";

const CELLS = [
  { name: "390x844", width: 390, height: 844, fontPx: null },
  { name: "320x568-200pct", width: 320, height: 568, fontPx: 32 },
] as const;

type Saved = { bodies: Record<string, unknown>[] };

async function mockSave(page: Page): Promise<Saved> {
  const saved: Saved = { bodies: [] };
  await page.route(
    (url) => url.pathname === "/api/segments",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      saved.bodies.push(route.request().postDataJSON());
      await route.fulfill({
        json: { status: "added", id: "intro-9f3a", version: 1 },
      });
    },
  );
  return saved;
}

async function openCard(page: Page, theme: Theme) {
  await openProject(page, e2eProjectPath);
  await setTheme(page, theme);
  await openPhoneTimeline(page);
  const clip = page.locator(".clip-hit").first();
  await clip.tap();
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  const more = page
    .getByRole("group", { name: "Edit actions" })
    .getByRole("button", { name: "More", exact: true });
  await openToolsIfFolded(page, more);
  await more.tap();
  await page
    .getByRole("menuitem", { name: "Save as segment", exact: true })
    .tap();
  const sheet = page.getByRole("dialog", { name: "Save as segment" });
  await expect(sheet).toBeVisible();
  return sheet;
}

for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
  test.describe(`save as segment iphone ${cell.name}`, () => {
    test.use({
      viewport: { width: cell.width, height: cell.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });
    });

    test("the sheet has 44 px controls, never scrolls sideways, and saves with a toast", async ({
      page,
    }) => {
      const saved = await mockSave(page);
      const sheet = await openCard(page, theme);
      if (cell.fontPx) await setRootFontSize(page, cell.fontPx);
      await expect(sheet.getByRole("textbox", { name: "Name" })).toBeVisible();
      await expectTouchTargets(sheet);
      await expectNoHorizontalScroll(page);
      await sheet.getByRole("button", { name: "Save" }).tap();
      await expect(sheet.getByRole("alert")).toHaveText(
        "Enter a name for the segment.",
      );
      await sheet.getByRole("textbox", { name: "Name" }).fill("Cold open");
      await sheet.getByRole("button", { name: "Save" }).tap();
      await expect(sheet).toHaveCount(0);
      await expectFeedback(page, "Saved Cold open to your library");
      expect(saved.bodies).toHaveLength(1);
      expect(saved.bodies[0]).toMatchObject({
        name: "Cold open",
        clip_ids: [expect.any(String)],
      });
    });
  });
}
