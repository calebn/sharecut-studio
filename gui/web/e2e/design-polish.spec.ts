import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    if (!channels || channels.length !== 3) {
      throw new Error(`Expected computed RGB color, got ${color}`);
    }
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("stage follows the theme and motion respects preference", async ({
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
    // Light mode gets a light stage; dark mode keeps the stage darkest.
    expect(colors.timeline).toBe(
      theme === "light" ? "rgb(230, 227, 221)" : "rgb(14, 12, 11)",
    );
    expect(colors.transport).toContain("gradient");
    expect(colors.transportHeight).toBe(56);
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

test("fixed phone playhead uses the stage playhead in each theme", async ({
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
  for (const [theme, color] of [
    ["light", "rgb(223, 75, 40)"],
    ["dark", "rgb(255, 109, 72)"],
  ] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(
      await playhead.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
      theme,
    ).toBe(color);
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`header plane ends at the track headers at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    if (viewport.width < 768) {
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Timeline" })
        .click();
    }
    await expect(page.locator(".lane-row").first()).toBeVisible();
    const plane = await page.evaluate(() => {
      const headers = document.querySelector(".timeline-scroll .track-headers");
      const scroll = document.querySelector(".timeline-scroll");
      if (!headers || !scroll) {
        throw new Error("timeline did not mount");
      }
      return {
        headers: Math.round(headers.getBoundingClientRect().width),
        gradient: getComputedStyle(scroll).backgroundImage,
      };
    });
    // The paper header plane must stop where the header column stops, or a
    // strip of it leaks into the stage (#20 review).
    expect(plane.gradient).toContain(`${plane.headers}px`);
  });
}

test("light transport keeps legible status and stable control hover paint", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator(".lane-row").first()).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });

  const colors = await page.locator(".transport").evaluate((transport) => {
    const swatch = document.createElement("span");
    swatch.style.color = "var(--color-transport-top)";
    transport.appendChild(swatch);
    const top = getComputedStyle(swatch).color;
    swatch.remove();
    const fresh = document.createElement("span");
    fresh.className = "pill ok";
    transport.appendChild(fresh);
    const ok = getComputedStyle(fresh).color;
    fresh.remove();
    const warning = getComputedStyle(
      transport.querySelector(".pill.warning")!,
    ).color;
    return { top, ok, warning };
  });
  expect(contrastRatio(colors.ok, colors.top)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.warning, colors.top)).toBeGreaterThanOrEqual(4.5);

  const play = page.getByRole("button", { name: "Play", exact: true });
  const playPaint = (element: typeof play) =>
    element.evaluate((node) => {
      const style = getComputedStyle(node);
      return { image: style.backgroundImage, color: style.color };
    });
  const playRest = await playPaint(play);
  await play.hover();
  expect(await playPaint(play)).toEqual(playRest);

  const row = page.locator(".track-header-row").first();
  const rowRest = await row.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await row.hover();
  const rowHover = await row.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(rowHover).not.toBe(rowRest);
});

test("compact light transport keeps Comment readable", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  const comment = page.locator(
    ".transport-primary-actions > .comment-mode-btn",
  );
  await expect(comment).toBeVisible();
  const colors = await comment.evaluate((button) => {
    const swatch = document.createElement("span");
    swatch.style.color = "var(--color-transport-top)";
    button.parentElement!.appendChild(swatch);
    const top = getComputedStyle(swatch).color;
    swatch.remove();
    return { top, ink: getComputedStyle(button).color };
  });
  expect(contrastRatio(colors.ink, colors.top)).toBeGreaterThanOrEqual(4.5);
});

test("Share dialog floats on the overlay rung over a dark scrim", async ({
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
    const panel = await dialog
      .locator(".command-palette-panel")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, shadow: style.boxShadow };
      });
    const scrim = await dialog
      .locator(".command-palette-scrim")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    // Overlay never sits below raised; light mode lifts with shadow + scrim.
    expect(
      contrastRatio(panel.background, "rgb(0, 0, 0)"),
      `${theme} overlay luminance`,
    ).toBeGreaterThanOrEqual(contrastRatio(raised, "rgb(0, 0, 0)"));
    if (theme === "dark") {
      expect(panel.background).not.toBe(raised);
    }
    expect(panel.shadow).not.toBe("none");
    expect(scrim, `${theme} scrim is black`).toMatch(
      /^(?:rgba\(0, 0, 0, 0\.\d+\)|color\(srgb 0 0 0 \/ 0\.\d+\))$/,
    );
  }
});

test("capture issue 20 review views", async ({ browser }) => {
  test.setTimeout(90_000);
  const directory = process.env.DESIGN_POLISH_SCREENSHOT_DIR;
  test.skip(!directory, "Set DESIGN_POLISH_SCREENSHOT_DIR for review capture");
  fs.mkdirSync(directory!, { recursive: true });

  // Light files keep their names (paired with before/); dark adds "-dark".
  for (const theme of ["light", "dark"] as const) {
    const suffix = theme === "light" ? "" : "-dark";
    const shot = (name: string) =>
      path.join(directory!, `${name}${suffix}.png`);
    const pinTheme = async (page: Page) =>
      page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);

    const desktop = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    try {
      await desktop.emulateMedia({
        reducedMotion: "reduce",
        colorScheme: theme,
      });
      await desktop.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
      await pinTheme(desktop);
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
      await desktop.screenshot({ path: shot("timeline") });

      await desktop
        .getByRole("button", { name: "Open track details, reference" })
        .focus();
      await desktop.keyboard.press("Enter");
      await expect(desktop.locator(".inspector")).toBeVisible();
      await desktop.screenshot({ path: shot("inspector") });

      await desktop.getByRole("button", { name: "Menu", exact: true }).click();
      await desktop.getByRole("menuitem", { name: /Share/ }).click();
      await expect(
        desktop.getByRole("dialog", { name: "Share" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          desktop
            .getByRole("dialog", { name: "Share" })
            .evaluate((dialog) => getComputedStyle(dialog).opacity),
        )
        .toBe("1");
      await desktop.screenshot({ path: shot("share-dialog") });
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
      await desktop.screenshot({ path: shot("empty-state") });
    } finally {
      await desktop.close();
    }

    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    try {
      await phone.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await phone.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
      await pinTheme(phone);
      await expect(
        phone.getByRole("navigation", { name: "Primary" }),
      ).toBeVisible();
      await expect(phone.locator(".listen-hero")).toBeVisible();
      await phone.screenshot({ path: shot("mobile-nav") });
    } finally {
      await phone.close();
    }
  }
});

test("capture empty timeline review view", async ({ page }) => {
  const directory = process.env.EMPTY_STAGE_SCREENSHOT_DIR;
  test.skip(
    !directory,
    "Set EMPTY_STAGE_SCREENSHOT_DIR with an empty E2E project",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  fs.mkdirSync(directory!, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect(
      page.getByRole("button", { name: "Drop audio files or import" }),
    ).toBeVisible();
    await expectPageAxeClean(page);
    await page.screenshot({
      path: path.join(
        directory!,
        theme === "light" ? "empty-timeline.png" : "empty-timeline-dark.png",
      ),
    });
  }
});
