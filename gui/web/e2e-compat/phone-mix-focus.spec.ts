import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { openPhoneMix } from "../e2e/phoneMix";
import { withShareableProject } from "../e2e/shareableProject";

async function openMixAfterKeyboardFocus(page: Page) {
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("button", { name: "More", exact: true }).click();
  const search = page.getByRole("button", {
    name: "Search commands",
    exact: true,
  });
  await search.focus();
  await expect(search).toBeFocused();

  const trigger = page.getByRole("button", { name: "Mix", exact: true });
  await trigger.click();
  const mix = page.getByRole("dialog", { name: "Mix", exact: true });
  await expect(mix).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    mix.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  return mix;
}

async function expectDismissedWithMixFocus(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mix", exact: true }),
  ).toBeFocused();
}

async function attachCloseFocus(page: Page, info: TestInfo) {
  await info.attach("focus-after-close", {
    body: JSON.stringify(
      await page.evaluate(() => ({
        active: document.activeElement?.outerHTML,
      })),
    ),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("focus-after-close.png") });
}

test("phone Mix restores literal Mix focus after a pointer opens it from keyboard focus", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    const mix = await openMixAfterKeyboardFocus(page);
    await mix.getByRole("button", { name: "Close", exact: true }).click();
    await attachCloseFocus(page, info);
    await expectDismissedWithMixFocus(page);
  });
});

test("phone Mix restores literal Mix focus after Escape", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    const mix = await openMixAfterKeyboardFocus(page);
    await page.keyboard.press("Escape");
    await expect(mix).toHaveCount(0);
    await expectDismissedWithMixFocus(page);
  });
});

test("phone Mix restores literal Mix focus after scrim dismissal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 1100 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    const mix = await openMixAfterKeyboardFocus(page);
    await page
      .getByRole("button", { name: "Dismiss", exact: true })
      .click({ position: { x: 8, y: 8 } });
    await expect(mix).toHaveCount(0);
    await expectDismissedWithMixFocus(page);
  });
});

test("phone Mix navigation invalidates the sheet and does not reopen it in More", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await openPhoneMix(page);
    await expect(page.getByRole("dialog")).toHaveCount(1);

    await page.keyboard.press("Alt+Shift+Tab");
    await page.keyboard.press("Alt+Shift+Tab");
    await page.keyboard.press("Alt+Shift+Tab");
    const nav = page.getByRole("navigation", { name: "Primary" });
    const text = nav.getByRole("button", { name: "Text", exact: true });
    await expect(text).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(text).toBeFocused();

    await page.keyboard.press("Alt+Tab");
    const more = nav.getByRole("button", { name: "More", exact: true });
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(more).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mix", exact: true }),
    ).toBeVisible();
  });
});
