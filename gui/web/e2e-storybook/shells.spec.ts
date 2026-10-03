import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";

async function openStory(
  page: Page,
  id: string,
  width: number,
  theme: string,
  embed = false,
) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(
    `/iframe.html?id=templates-${id}&viewMode=story&globals=theme:${theme}&embed=${embed}`,
  );
  await expect(page.locator(".daw-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.evaluate(() => document.fonts.ready);
}

async function expectShellFit(page: Page, width: number) {
  const geometry = await page.locator(".daw-shell").evaluate((shell) => {
    const main = shell.querySelector("main");
    if (!main) throw new Error("Shell has no main region");
    const rect = shell.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      height: rect.height,
      bodyHeight: main.getBoundingClientRect().height,
      documentWidth: document.documentElement.scrollWidth,
      shellWidth: shell.clientWidth,
      scrollWidth: shell.scrollWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(width);
  expect(geometry.documentWidth).toBeLessThanOrEqual(width);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.shellWidth);
  expect(geometry.height).toBe(900);
  expect(geometry.bodyHeight).toBeGreaterThan(200);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
}

for (const theme of ["light", "dark"]) {
  test(`phone360 Listen and Timeline fit and navigate in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, "mobileshell--phone-360", 360, theme);
    const timeline = page.getByRole("button", {
      name: "Timeline",
      exact: true,
    });
    await expect(timeline).toHaveAttribute("aria-pressed", "true");
    await expectShellFit(page, 360);
    const nav = await page
      .getByRole("navigation", { name: "Primary" })
      .boundingBox();
    if (!nav) throw new Error("Primary navigation has no rectangle");
    expect(nav.y + nav.height).toBeLessThanOrEqual(900);
    await page.getByRole("button", { name: "Listen", exact: true }).click();
    await expect(page.locator(".daw-shell--listen")).toBeVisible();
    await expect(page.locator(".daw-shell-transport")).toHaveCount(0);
    await expectShellFit(page, 360);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await timeline.click();
    await expect(
      page.locator(".daw-shell-transport > .transport"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Open track details, Mira" })
      .focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Inspector" });
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    await expect
      .poll(async () => {
        const sheet = await dialog.boundingBox();
        const navigation = await page
          .getByRole("navigation", { name: "Primary" })
          .boundingBox();
        return sheet && navigation
          ? sheet.y + sheet.height - navigation.y
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(0);

    await expect(
      page.locator(".bottom-sheet-scrim--interactive"),
    ).toBeVisible();
    await expectPageAxeClean(page);
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Text", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Welcome." })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expectShellFit(page, 360);
  });

  test(`phone360 More back and guest follow chrome fit in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, "mobileshell--more-comments", 360, theme, true);
    await expect(page.getByText("Keep this introduction.")).toBeVisible();
    await expectShellFit(page, 360);
    await expectPageAxeClean(page);
    await page.getByRole("button", { name: "← More" }).click();
    await expect(
      page.getByText("Comments, history, and project tools live in More."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "← More" })).toHaveCount(0);
    await expectShellFit(page, 360);
    await expectPageAxeClean(page);
    await openStory(page, "mobileshell--guest-following", 360, theme, true);
    await expect(page.locator(".daw-shell--following")).toBeVisible();
    await expectShellFit(page, 360);
    await expectPageAxeClean(page);
    await page.getByRole("button", { name: "Stop following" }).click();
    await expect(
      page.getByRole("button", { name: "Stop following" }),
    ).toHaveCount(0);
    await expect(page.locator(".guest-banner")).toHaveText("Guest · View only");
    await expectShellFit(page, 360);
    await expectPageAxeClean(page);
  });

  test(`desktop shell tabs, keyboard splitter and inspector fit in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, "studioshell--desktop", 1440, theme);
    await expect(page.locator(".transport")).toHaveAttribute(
      "data-playing",
      "true",
    );
    await expect(
      page.getByRole("button", { name: "Transcript", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expectShellFit(page, 1440);
    const splitter = page.getByRole("separator", {
      name: "Resize editor panels",
    });
    await splitter.focus();
    await page.keyboard.press("ArrowUp");
    await expect(splitter).toHaveAttribute("aria-valuenow", "12.8");
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(page.getByText("Keep this introduction.")).toBeVisible();
    await page
      .getByRole("button", { name: "Open track details, Mira" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("main .inspector")).toHaveText(
      "MiraDialogue track",
    );
    await expectShellFit(page, 1440);
    await expectPageAxeClean(page);
  });

  test(`desktop guest tabs and loading stay bounded in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, "studioshell--guest-following", 1440, theme, true);
    await expect(page.locator(".daw-shell--following")).toBeVisible();
    await expectShellFit(page, 1440);
    await expectPageAxeClean(page);
    await page.getByRole("button", { name: "Stop following" }).click();
    await expect(
      page.getByRole("button", { name: "Stop following" }),
    ).toHaveCount(0);
    await expect(page.locator(".tab-bar button")).toHaveText([
      "Transcript",
      "Comments",
    ]);
    await expectShellFit(page, 1440);
    await expectPageAxeClean(page);
    await openStory(page, "studioshell--loading", 1440, theme);
    await expect(page.getByLabel("Loading timeline")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Drop audio files or import" }),
    ).toHaveCount(0);
    await expectShellFit(page, 1440);
    await expectPageAxeClean(page);
  });

  test(`empty ingest target remains usable after coach dismissal in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, "studioshell--empty-ingest", 1440, theme);
    await expect(page.getByRole("button", { name: "Got it" })).toHaveCount(0);
    const target = page.getByRole("button", {
      name: "Drop audio files or import",
    });
    await expect(target).toBeVisible();
    await target.focus();
    await expect(target).toBeFocused();
    await expectShellFit(page, 1440);
    await expectPageAxeClean(page);
  });

  test(`tablet inspector portal preserves tabs and interactive background in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, "studioshell--tablet-inspector", 1024, theme);
    await expect(page.getByRole("dialog", { name: "Inspector" })).toHaveCount(
      0,
    );
    await page
      .getByRole("button", { name: "Open track details, Mira" })
      .focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Inspector" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    const bounds = await dialog.boundingBox();
    if (!bounds) throw new Error("Inspector has no rendered rectangle");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1024);
    await expect
      .poll(async () => {
        const settled = await dialog.boundingBox();
        const panels = await page.locator(".bottom-tabs").boundingBox();
        return settled && panels
          ? settled.y + settled.height - panels.y
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Comments", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(dialog).toBeVisible();
    await expectShellFit(page, 1024);
    await expectPageAxeClean(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
