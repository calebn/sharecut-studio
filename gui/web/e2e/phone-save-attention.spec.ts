import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

const failedSaveInit = () => {
  // An unreadable offline queue is the Failed save state, with the Needs attention banner up.
  indexedDB.open = () => {
    throw new Error("queue unreadable");
  };
};

const MODES = ["Listen", "Timeline", "Text", "More"] as const;

async function openPhone(
  page: Page,
  { failed, rootPx }: { failed: boolean; rootPx?: number },
) {
  if (failed) await page.addInitScript(failedSaveInit);
  if (rootPx) {
    await page.addInitScript((size) => {
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.fontSize = `${size}px`;
      });
    }, rootPx);
  }
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator("[data-save-state]")).toBeVisible();
}

function mode(page: Page, name: (typeof MODES)[number]) {
  return page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name, exact: true });
}

/** Distance from the mode body's top edge to the first thing the mode draws in it. */
async function contentOffset(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector(".mobile-mode-body");
    const first = [...(body?.children ?? [])].find(
      (child) =>
        !child.classList.contains("mobile-status-row") &&
        child.getBoundingClientRect().height > 0,
    );
    if (!body || !first) return null;
    return first.getBoundingClientRect().top - body.getBoundingClientRect().top;
  });
}

test.describe("phone save attention", () => {
  test.use({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
  });

  test("a Failed light moves no mode content and takes no tap", async ({
    browser,
  }) => {
    const offsets: Record<string, Array<number | null>> = {};
    for (const failed of [false, true]) {
      const context = await browser.newContext({
        viewport: { width: 375, height: 667 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      await openPhone(page, { failed });
      const state = failed ? "failed" : "saved";
      await expect(page.locator("[data-save-state]")).toHaveAttribute(
        "data-save-state",
        state,
      );
      offsets[state] = [];
      for (const name of MODES) {
        await mode(page, name).click();
        offsets[state].push(await contentOffset(page));
        const box = (await page.locator("[data-save-state]").boundingBox())!;
        const below = await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest("[data-save-state]") !==
            null,
          { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        );
        expect(below, `${state} light in ${name} takes no tap`).toBe(false);
      }
      await context.close();
    }
    expect(
      offsets.failed,
      "mode content sits where it does when Saved",
    ).toEqual(offsets.saved);
  });

  test("More keeps Search commands tappable while Saved", async ({ page }) => {
    await openPhone(page, { failed: false });
    await mode(page, "More").click();
    const search = page.locator(".mobile-more-search");
    await expect(search).toBeVisible();
    await search.tap();
    await expect(
      page.getByRole("combobox", { name: "Search commands" }),
    ).toBeFocused();
  });

  test("Listen takes a tap just below the Saved light", async ({ page }) => {
    await openPhone(page, { failed: false });
    await mode(page, "Listen").click();
    const box = (await page.locator("[data-save-state]").boundingBox())!;
    const reaches = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest("[data-save-state]") === null,
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

  test("Listen keeps a mode body, the banner and the navigation on screen", async ({
    page,
  }) => {
    await openPhone(page, { failed: true, rootPx: 32 });
    await mode(page, "Listen").click();
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box && { top: box.top, bottom: box.bottom, height: box.height };
      };
      return {
        body: rect(".mobile-mode-body"),
        banner: rect(".daw-shell-banners"),
        nav: rect(".mobile-nav"),
        shellScroll: document.querySelector(".daw-shell")?.scrollTop,
        height: window.innerHeight,
      };
    });
    expect(geometry.body?.height ?? 0).toBeGreaterThan(0);
    expect(geometry.banner?.top ?? -1).toBeGreaterThanOrEqual(0);
    expect(geometry.nav?.bottom ?? Infinity).toBeLessThanOrEqual(
      geometry.height,
    );
    expect(geometry.shellScroll, "the shell does not scroll").toBe(0);
    await mode(page, "Text").click();
    await expect(mode(page, "Text")).toHaveAttribute("aria-pressed", "true");
  });

  test("the banner's details open with Retry reachable", async ({ page }) => {
    await openPhone(page, { failed: true, rootPx: 32 });
    await mode(page, "Listen").click();
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
