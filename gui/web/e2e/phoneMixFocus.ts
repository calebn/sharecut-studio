import { expect, type Page, type TestInfo } from "@playwright/test";
import { openPhoneMix } from "./phoneMix";
import { withShareableProject } from "./shareableProject";

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

async function inFreshPhoneProject(
  page: Page,
  viewportHeight: number,
  check: () => Promise<void>,
) {
  await page.setViewportSize({ width: 360, height: viewportHeight });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await check();
  });
}

export async function checkPhoneMixFocus(page: Page, info: TestInfo) {
  await inFreshPhoneProject(page, 740, async () => {
    const mix = await openMixAfterKeyboardFocus(page);
    await mix.getByRole("button", { name: "Close", exact: true }).click();
    await attachCloseFocus(page, info);
    await expectDismissedWithMixFocus(page);
  });

  await inFreshPhoneProject(page, 740, async () => {
    const mix = await openMixAfterKeyboardFocus(page);
    await page.keyboard.press("Escape");
    await expect(mix).toHaveCount(0);
    await expectDismissedWithMixFocus(page);
  });

  await inFreshPhoneProject(page, 1100, async () => {
    const mix = await openMixAfterKeyboardFocus(page);
    await page
      .getByRole("button", { name: "Dismiss", exact: true })
      .click({ position: { x: 8, y: 8 } });
    await expect(mix).toHaveCount(0);
    await expectDismissedWithMixFocus(page);
  });

  await inFreshPhoneProject(page, 740, async () => {
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
}
