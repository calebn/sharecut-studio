import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { goToStage, openProject, saveStatus } from "./stageNav";

const failedSaveInit = () => {
  // An unreadable offline queue is the Failed save state, with the Needs attention banner up.
  indexedDB.open = () => {
    throw new Error("queue unreadable");
  };
};

async function openPhone(
  page: Page,
  {
    failed,
    rootPx,
    stage,
  }: { failed: boolean; rootPx?: number; stage?: "edit" | "review" },
) {
  if (failed) await page.addInitScript(failedSaveInit);
  if (rootPx) {
    await page.addInitScript((size) => {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = `${size}px`;
      });
    }, rootPx);
  }
  await openProject(page, e2eProjectPath, { stage });
  await expect(saveStatus(page)).toBeVisible();
}

test.describe("phone save attention", () => {
  test.use({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
  });

  test("a Failed save keeps Retry in the header and the stage reachable", async ({
    page,
  }) => {
    await openPhone(page, { failed: true });
    const status = page.getByRole("group", { name: "Save status" });
    await expect(status).toBeVisible();
    const retry = status.getByRole("button", { name: /^Retry/ });
    await expect(retry).toBeVisible();
    const box = (await retry.boundingBox())!;
    const hit = await retry.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const at = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return at === element || (at !== null && element.contains(at));
    });
    expect(hit, "Retry takes a tap").toBe(true);
    expect(box.y + box.height).toBeLessThanOrEqual(667);
    await goToStage(page, "review");
    await expect(page.getByRole("main", { name: "Review" })).toBeVisible();
  });

  test("the Palette stays tappable while Saved", async ({ page }) => {
    await openPhone(page, { failed: false });
    await page.getByRole("button", { name: /^Palette\b/ }).tap();
    await expect(
      page.getByRole("combobox", { name: "Search commands" }),
    ).toBeFocused();
  });

  test("Review takes a tap just below the Saved light", async ({ page }) => {
    await openPhone(page, { failed: false });
    await goToStage(page, "review");
    const box = (await saveStatus(page).boundingBox())!;
    const reaches = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest(".sys-save") === null,
      { x: box.x + box.width / 2, y: box.y + box.height + 12 },
    );
    expect(reaches).toBe(true);
  });
});

test.describe("phone save attention in a short window at twice the text size", () => {
  test.use({
    viewport: { width: 667, height: 360 },
    isMobile: true,
    hasTouch: true,
  });

  test("Review keeps a stage body, the banner and the Stage menu on screen", async ({
    page,
  }) => {
    // At twice the text size this window folds the tab bar into the header's
    // Stage menu, so the header, banner and mini Player leave the stage a body.
    await openPhone(page, { failed: true, rootPx: 32, stage: "review" });
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box && { top: box.top, bottom: box.bottom, height: box.height };
      };
      return {
        body: rect(".stage-frame-body"),
        banner: rect(".stage-frame-banners"),
        stageMenu: rect(".sys-header-stage-button"),
        frameScroll: document.querySelector(".stage-frame")?.scrollTop,
        height: window.innerHeight,
      };
    });
    expect(geometry.body?.height ?? 0).toBeGreaterThan(0);
    expect(geometry.banner?.top ?? -1).toBeGreaterThanOrEqual(0);
    expect(
      geometry.stageMenu?.height ?? 0,
      "the Stage menu shows",
    ).toBeGreaterThan(0);
    expect(geometry.stageMenu?.bottom ?? Infinity).toBeLessThanOrEqual(
      geometry.height,
    );
    expect(geometry.frameScroll, "the frame does not scroll").toBe(0);
  });

  test("the banner's details open with Retry reachable", async ({ page }) => {
    await openPhone(page, { failed: true, rootPx: 32, stage: "review" });
    const attention = page.getByRole("region", {
      name: /Saved edits could not be read/,
    });
    await expect(attention).toBeVisible();
    await attention.locator("summary").click();
    const retry = attention.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    const box = (await retry.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(360);
    const reaches = await retry.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return hit === element || (hit !== null && element.contains(hit));
    });
    expect(reaches).toBe(true);
  });
});
