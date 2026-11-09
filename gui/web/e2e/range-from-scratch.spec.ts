import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { openHostProject } from "./overlayReachability";
import { armRange, setScrub } from "./stageNav";

const fields = (page: Page) =>
  page.getByRole("region", { name: "Range fields" });
const field = (page: Page, name: string) =>
  fields(page).getByRole("spinbutton", { name, exact: true });
const undoButton = (page: Page) =>
  page.locator(".sys-header-history").getByRole("button", { name: /^Undo/ });

test.describe("typed range from scratch on desktop", () => {
  test("arming seeds a draft and the first commit selects a range", async ({
    page,
  }) => {
    await openHostProject(page);
    await armRange(page);
    await expect(fields(page)).toBeVisible();
    await expect(field(page, "In")).toHaveAttribute("aria-valuenow", "0");
    await expect(field(page, "Out")).toHaveAttribute("aria-valuenow", "5");
    await expect(field(page, "Length")).toHaveAttribute("aria-valuenow", "5");
    await expect(page.locator(".range-overlay")).toHaveCount(0);

    await field(page, "In").focus();
    await field(page, "In").press("Enter");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");

    await expect(page.locator(".range-overlay").first()).toBeVisible();
    await expect(field(page, "In")).toHaveAttribute("aria-valuenow", "3");
    await expect(field(page, "Out")).toHaveAttribute("aria-valuenow", "5");
  });

  test("Esc drops the draft without touching History", async ({ page }) => {
    await openHostProject(page);
    const before = await undoButton(page).evaluate((el) => el.outerHTML);
    await armRange(page);
    await expect(fields(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(fields(page)).toHaveCount(0);
    await expect(page.locator("[data-range-armed]")).toHaveCount(0);
    await expect(page.locator(".range-overlay")).toHaveCount(0);
    expect(await undoButton(page).evaluate((el) => el.outerHTML)).toBe(before);
  });

  test("Esc while typing cancels only the text", async ({ page }) => {
    await openHostProject(page);
    await armRange(page);
    await field(page, "In").focus();
    await field(page, "In").press("Enter");
    await page.keyboard.type("2");
    await page.keyboard.press("Escape");
    await expect(fields(page)).toBeVisible();
    await expect(field(page, "In")).toHaveAttribute("aria-valuenow", "0");
    await expect(field(page, "In")).toBeFocused();
    await setScrub(page, field(page, "In"), "1");
    await expect(page.locator(".range-overlay").first()).toBeVisible();
  });
});

test.describe("typed range from scratch on a phone", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("the corner bracket opens the sheet with the draft and no agent region", async ({
    page,
  }) => {
    await openHostProject(page);
    await armRange(page);
    await expect(fields(page)).toBeVisible();
    await expect(
      fields(page).getByRole("button", { name: /agent range/i }),
    ).toHaveCount(0);
    await expectPageAxeClean(page, ".sys-inspector--phone");
    await field(page, "In").focus();
    await field(page, "In").press("Enter");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("1");
    await page.keyboard.press("Tab");
    await expect(page.locator(".range-overlay").first()).toBeVisible();
    await expect(field(page, "In")).toHaveAttribute("aria-valuenow", "1");
    await expect(field(page, "Out")).toBeFocused();
    await setScrub(page, field(page, "Out"), "4");
    await expect(page.locator(".range-overlay").first()).toBeVisible();
    await expect(field(page, "Out")).toHaveAttribute("aria-valuenow", "4");
  });
});
