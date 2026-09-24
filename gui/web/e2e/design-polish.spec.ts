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
      const playheadMotion = getComputedStyle(playhead).transitionDuration;
      playhead.remove();
      const control = document.createElement("button");
      control.className = "ui-control";
      document.body.appendChild(control);
      const controlMotion = getComputedStyle(control).transitionDuration;
      control.remove();
      const ruler = document.createElement("div");
      ruler.className = "time-ruler";
      const rulerPlayhead = document.createElement("div");
      rulerPlayhead.className = "playhead";
      ruler.appendChild(rulerPlayhead);
      document.body.appendChild(ruler);
      const rulerGlow = getComputedStyle(
        rulerPlayhead,
        "::before",
      ).backgroundImage;
      ruler.remove();
      return {
        timeline: getComputedStyle(timeline).backgroundColor,
        transport: getComputedStyle(transport).backgroundImage,
        transportHeight: Math.round(transport.getBoundingClientRect().height),
        playheadMotion,
        controlMotion,
        rulerGlow,
      };
    });
    expect(colors.timeline).toBe(
      theme === "light" ? "rgb(43, 37, 33)" : "rgb(12, 14, 14)",
    );
    expect(colors.transport).toContain("gradient");
    expect(colors.transportHeight).toBe(72);
    expect(colors.playheadMotion).toBe("0s");
    expect(colors.controlMotion).toBe("0s");
    expect(colors.rulerGlow).toContain("gradient");
  }

  await expectPageAxeClean(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const control = document.createElement("button");
        control.className = "ui-control";
        document.body.appendChild(control);
        const motion = getComputedStyle(control).transitionDuration;
        control.remove();
        return motion;
      }),
    )
    .not.toBe("0s");
});

test("fixed phone playhead stays visible on the dark timeline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Timeline" })
    .click();
  const playhead = page.locator(
    ".timeline-area--fixed-playhead .playhead--fixed",
  );
  await expect(playhead).toBeVisible();
  expect(
    await playhead.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe("rgb(255, 109, 72)");
});

test("Share dialog floats on a distinct tone from the raised inspector", async ({
  page,
}) => {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await page
    .getByRole("button", { name: "Open track details, reference" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".inspector")).toBeVisible();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("menuitem", { name: /Share/ }).click();
  const dialog = page.getByRole("dialog", { name: "Share" });
  await expect(dialog).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const raised = await page
      .locator(".inspector")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    const overlay = await dialog
      .locator(".command-palette-panel")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(overlay, `${theme} overlay should differ from raised`).not.toBe(
      raised,
    );
  }
});

test("capture issue 20 review views", async ({ browser }) => {
  test.setTimeout(30_000);
  const directory = process.env.DESIGN_POLISH_SCREENSHOT_DIR;
  test.skip(!directory, "Set DESIGN_POLISH_SCREENSHOT_DIR for review capture");
  fs.mkdirSync(directory!, { recursive: true });

  const desktop = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  try {
    await desktop.emulateMedia({ reducedMotion: "reduce" });
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
    await expect
      .poll(() =>
        desktop
          .getByRole("dialog", { name: "Share" })
          .evaluate((dialog) => getComputedStyle(dialog).opacity),
      )
      .toBe("1");
    await desktop.screenshot({
      path: path.join(directory!, "share-dialog.png"),
    });
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
    await desktop.screenshot({
      path: path.join(directory!, "empty-state.png"),
    });
  } finally {
    await desktop.close();
  }

  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  try {
    await phone.emulateMedia({ reducedMotion: "reduce" });
    await phone.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(
      phone.getByRole("navigation", { name: "Primary" }),
    ).toBeVisible();
    await phone.screenshot({ path: path.join(directory!, "mobile-nav.png") });
  } finally {
    await phone.close();
  }
});

test("capture empty timeline review view", async ({ page }) => {
  const directory = process.env.EMPTY_STAGE_SCREENSHOT_DIR;
  test.skip(
    !directory,
    "Set EMPTY_STAGE_SCREENSHOT_DIR with an empty E2E project",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(
    page.getByRole("button", { name: "Drop audio files or import" }),
  ).toBeVisible();
  await expectPageAxeClean(page);
  fs.mkdirSync(directory!, { recursive: true });
  await page.screenshot({ path: path.join(directory!, "empty-timeline.png") });
});
