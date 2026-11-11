import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";
import {
  deliverPage,
  goToStage,
  openProject,
  openProjectDialog,
} from "./stageNav";

test.use({
  hasTouch: true,
  isMobile: true,
  permissions: ["clipboard-read", "clipboard-write"],
});

/** The Invite sheet on a phone: a bottom sheet over the stage. */
async function openInvite(page: Page, projectPath: string): Promise<Locator> {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, projectPath);
  await goToStage(page, "edit");
  await openProjectDialog(page, "share");
  const sheet = page.getByRole("dialog", { name: "Invite" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Looking for your links…")).toBeHidden();
  return sheet;
}

async function expectWithinWidth(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 0.5);
}

function expectTouchHeight(height: number, layoutHeight: number): void {
  expect(layoutHeight).toBeGreaterThanOrEqual(44);
  // Translated DOM rectangles can report 43.999996px for a 44px layout box.
  expect(height).toBeGreaterThanOrEqual(44 - 0.001);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
}

test("phone 390x844: Listen link follows Episode file in the one column", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openProject(page, projectPath);
    await goToStage(page, "deliver");
    const region = deliverPage(page).getByRole("region", {
      name: "Listen link",
    });
    await region.scrollIntoViewIfNeeded();
    await expect(region).toBeVisible();
    const titles = await deliverPage(page)
      .getByRole("heading", { level: 2 })
      .allTextContents();
    expect(titles.indexOf("Listen link")).toBeGreaterThan(
      titles.indexOf("Episode file"),
    );
    await expectWithinWidth(region);
    await expectNoHorizontalScroll(page);
    await expectPageAxeClean(page, ".dv-stage");
  });
});

test("phone 390x844: the sheet's controls are 44 px and fit the width", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await createReviewShare(page, projectPath, "editor");
    const sheet = await openInvite(page, projectPath);
    await expectWithinWidth(sheet);
    const controls = sheet.locator(".sys-link button, .ui-segmented button");
    const sizes = await controls.evaluateAll((els) =>
      els.map((el) => ({
        height: el.getBoundingClientRect().height,
        layoutHeight: el instanceof HTMLElement ? el.offsetHeight : 0,
      })),
    );
    expect(sizes.length).toBeGreaterThanOrEqual(4);
    for (const size of sizes) expectTouchHeight(size.height, size.layoutHeight);
    await expectNoHorizontalScroll(page);
    await expectPageAxeClean(page, '[role="dialog"]');
  });
});

test("phone 390x844: a stale mix shows its notice and Refresh mix inside the width", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    const sheet = await openInvite(page, projectPath);
    await page.route("**/api/shares", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 409,
          headers: { "X-Sharecut-Error-Code": "stale_mix" },
          json: { detail: "premix.wav is stale" },
        });
        return;
      }
      await route.fallback();
    });
    await sheet
      .getByRole("button", { name: "Copy new Commenter link" })
      .click();
    await expectWithinWidth(sheet.getByRole("alert"));
    const refresh = sheet.getByRole("button", { name: "Refresh mix" });
    await expectWithinWidth(refresh);
    const size = await refresh.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      layoutHeight: el instanceof HTMLElement ? el.offsetHeight : 0,
    }));
    expectTouchHeight(size.height, size.layoutHeight);
  });
});

test("phone 390x844: every online sharing state fits the width", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await createReviewShare(page, projectPath, "viewer");
    let state = "offline";
    await page.route("**/api/tunnel/status", (route) =>
      route.fulfill({
        json: {
          state,
          reason: null,
          reason_kind: "auth",
          relay_host: "relay.example.test",
          public_base_url: "https://share.example.test",
          share_count: 1,
          retry_at: state === "reconnecting" ? Date.now() / 1000 + 30 : null,
        },
      }),
    );
    const sheet = await openInvite(page, projectPath);
    const headline = sheet.locator(".share-tunnel-headline");
    await expect(headline).toContainText("Not reachable online");
    await expectWithinWidth(headline);
    await sheet.getByText("How to fix").click();
    await expectWithinWidth(
      sheet.getByRole("link", { name: /Online sharing guide/ }),
    );
    for (const [next, text] of [
      ["reconnecting", /^Reconnecting…/],
      ["off", "Online sharing is off"],
      ["online", "Guests can open your links"],
    ] as const) {
      state = next;
      await expect(headline).toContainText(text, { timeout: 15_000 });
      await expectWithinWidth(headline);
    }
    await expectNoHorizontalScroll(page);
  });
});
