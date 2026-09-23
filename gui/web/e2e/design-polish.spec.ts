import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test("timeline stays recessed across themes and motion respects preference", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator(".lane-row").first()).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const colors = await page.evaluate(() => {
      const timeline = document.querySelector(".timeline-area");
      const transport = document.querySelector(".transport");
      if (!timeline || !transport) {
        throw new Error("Studio chrome did not mount");
      }
      const playhead = document.createElement("div");
      playhead.className = "playhead";
      document.body.appendChild(playhead);
      const motion = getComputedStyle(playhead).transitionDuration;
      playhead.remove();
      return {
        timeline: getComputedStyle(timeline).backgroundColor,
        transport: getComputedStyle(transport).backgroundColor,
        playhead: motion,
      };
    });
    expect(colors.timeline).toBe("rgb(12, 14, 14)");
    expect(colors.timeline).not.toBe(colors.transport);
    expect(colors.playhead).toBe("0s");
  }

  await expectPageAxeClean(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const playhead = document.createElement("div");
        playhead.className = "playhead";
        document.body.appendChild(playhead);
        const motion = getComputedStyle(playhead).transitionDuration;
        playhead.remove();
        return motion;
      }),
    )
    .not.toBe("0s");
});

test("capture issue 20 review views", async ({ browser }) => {
  test.setTimeout(30_000);
  const directory = process.env.DESIGN_POLISH_SCREENSHOT_DIR;
  test.skip(!directory, "Set DESIGN_POLISH_SCREENSHOT_DIR for review capture");
  fs.mkdirSync(directory!, { recursive: true });

  const desktop = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await desktop.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(desktop.locator(".lane-row").first()).toBeVisible();
  await expect
    .poll(async () =>
      desktop
        .locator("canvas.clip-waveform")
        .first()
        .evaluate((canvas) => {
          const surface = canvas as HTMLCanvasElement;
          if (!surface.width || !surface.height) return false;
          const pixels = surface
            .getContext("2d")
            ?.getImageData(0, 0, surface.width, surface.height).data;
          return pixels
            ? pixels.some((value, index) => index % 4 === 3 && value > 0)
            : false;
        }),
    )
    .toBe(true);
  await desktop.screenshot({ path: path.join(directory!, "timeline.png") });

  await desktop
    .getByRole("button", { name: "Open track details, reference" })
    .focus();
  await desktop.keyboard.press("Enter");
  await expect(desktop.locator(".inspector")).toBeVisible();
  await desktop.screenshot({ path: path.join(directory!, "inspector.png") });

  await desktop.getByRole("button", { name: "Menu", exact: true }).click();
  await desktop.getByRole("menuitem", { name: /Share/ }).click();
  await expect(desktop.getByRole("dialog", { name: "Share" })).toBeVisible();
  await desktop.screenshot({ path: path.join(directory!, "share-dialog.png") });
  await desktop
    .getByRole("dialog", { name: "Share" })
    .getByRole("button", { name: "Close", exact: true })
    .click();

  await desktop
    .getByLabel("Editor panels")
    .getByRole("button", { name: "Tighten", exact: true })
    .click();
  await expect(
    desktop.getByText("No pending tighten decisions."),
  ).toBeVisible();
  await desktop.screenshot({ path: path.join(directory!, "empty-state.png") });
  await desktop.close();

  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await phone.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(
    phone.getByRole("navigation", { name: "Primary" }),
  ).toBeVisible();
  await phone.screenshot({ path: path.join(directory!, "mobile-nav.png") });
  await phone.close();
});
