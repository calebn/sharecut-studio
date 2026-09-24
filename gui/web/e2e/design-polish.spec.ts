import fs from "node:fs";
import path from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { openPhoneTimeline } from "./phoneTimeline";
import { setTheme } from "./theme";

// Contexts opened from the worker-scoped browser (capture test); closed here
// so a timeout never leaves a page connected to the shared e2e project.
const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(
    openContexts.splice(0).map((context) => context.close().catch(() => {})),
  );
});

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
    await setTheme(page, theme);
    const colors = await page.evaluate(() => {
      const timeline = document.querySelector(".timeline-area");
      const transport = document.querySelector(".transport");
      if (!timeline || !transport) {
        throw new Error("Studio chrome did not mount");
      }
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
      const glowStyle = getComputedStyle(rulerPlayhead, "::before");
      const rulerGlow = glowStyle.backgroundImage;
      // The ruler glow is the stage element that transitions; reduced
      // motion must zero it.
      const rulerMotion = glowStyle.transitionDuration;
      ruler.remove();
      return {
        timeline: getComputedStyle(timeline).backgroundColor,
        transport: getComputedStyle(transport).backgroundImage,
        transportHeight: Math.round(transport.getBoundingClientRect().height),
        rulerMotion,
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
    expect(colors.rulerMotion).toBe("0s");
    expect(colors.controlMotion).toBe("0s");
    expect(colors.rulerGlow).toContain("gradient");
    await expectPageAxeClean(page);
  }

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const control = document.createElement("button");
        control.className = "ui-control";
        const ruler = document.createElement("div");
        ruler.className = "time-ruler";
        const rulerPlayhead = document.createElement("div");
        rulerPlayhead.className = "playhead";
        ruler.appendChild(rulerPlayhead);
        document.body.append(control, ruler);
        const motion = [
          getComputedStyle(control).transitionDuration,
          getComputedStyle(rulerPlayhead, "::before").transitionDuration,
        ];
        control.remove();
        ruler.remove();
        return motion.includes("0s") ? "0s" : "moving";
      }),
    )
    .toBe("moving");
});

test("fixed phone playhead uses the stage playhead in each theme", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await openPhoneTimeline(page);
  const playhead = page.locator(
    ".timeline-area--fixed-playhead .playhead--fixed",
  );
  await expect(playhead).toBeVisible();
  for (const [theme, color] of [
    ["light", "rgb(223, 75, 40)"],
    ["dark", "rgb(255, 109, 72)"],
  ] as const) {
    await setTheme(page, theme);
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
      await openPhoneTimeline(page);
    }
    // The loading skeleton also draws lanes (with the header column outside
    // the scroller), so wait for the loaded arrange layout itself.
    await expect(page.locator(".timeline-scroll .track-headers")).toBeVisible();
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

test("transport zones never overlap across desktop widths", async ({
  page,
}) => {
  // The fixture is stale with no preview, so the end zone carries two
  // warning pills: wider than half the centered grid's spare room at 1440.
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator(".timeline-scroll .track-headers")).toBeVisible();
  for (const width of [1280, 1360, 1440, 1520, 1680, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const zones = await page.evaluate(() =>
      [...document.querySelectorAll("header.transport .transport-zone")].map(
        (zone) => {
          const boxes = [...zone.children]
            .map((child) => child.getBoundingClientRect())
            .filter((box) => box.width > 0);
          return {
            left: Math.min(...boxes.map((box) => box.left)),
            right: Math.max(...boxes.map((box) => box.right)),
          };
        },
      ),
    );
    expect(zones, `${width}px`).toHaveLength(3);
    const [start, center, end] = zones;
    expect(start.right, `${width}px start vs center`).toBeLessThanOrEqual(
      center.left,
    );
    expect(center.right, `${width}px center vs end`).toBeLessThanOrEqual(
      end.left,
    );
    expect(end.right, `${width}px end vs viewport`).toBeLessThanOrEqual(width);
  }
});

test("light transport keeps legible status and stable control hover paint", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator(".lane-row").first()).toBeVisible();
  await setTheme(page, "light");
  // Stale render (or the async audio-error pill) must be on screen first.
  await expect(page.locator(".transport .pill.warning").first()).toBeVisible();

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
    const pill = transport.querySelector(".pill.warning");
    if (!pill) {
      throw new Error("warning pill vanished");
    }
    const warning = getComputedStyle(pill).color;
    return { top, ok, warning };
  });
  expect(contrastRatio(colors.ok, colors.top)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.warning, colors.top)).toBeGreaterThanOrEqual(4.5);

  const play = page.getByRole("button", { name: "Play", exact: true });
  const playPaint = (element: typeof play) =>
    element.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        fill: style.backgroundColor,
        image: style.backgroundImage,
        shadow: style.boxShadow,
        color: style.color,
      };
    });
  const playRest = await playPaint(play);
  await play.hover();
  expect(await playPaint(play)).toEqual(playRest);

  // Unselected strip segments lift to the transport control fill on hover,
  // never the light-pane sunken wash.
  const controlFill = await page.locator(".transport").evaluate((transport) => {
    const swatch = document.createElement("span");
    swatch.style.backgroundColor = "var(--color-transport-control)";
    transport.appendChild(swatch);
    const fill = getComputedStyle(swatch).backgroundColor;
    swatch.remove();
    return fill;
  });
  const fx = page
    .getByRole("group", { name: "Audition mode" })
    .getByRole("button", { name: "FX", exact: true });
  await fx.hover();
  await expect(fx).toHaveCSS("background-color", controlFill);

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
  // Measure against the button's own fill (the control paint), not the strip.
  const colors = await comment.evaluate((button) => {
    const style = getComputedStyle(button);
    return { fill: style.backgroundColor, ink: style.color };
  });
  expect(colors.fill).not.toBe("rgba(0, 0, 0, 0)");
  expect(contrastRatio(colors.ink, colors.fill)).toBeGreaterThanOrEqual(4.5);
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
    await setTheme(page, theme);
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

test("primary buttons keep their fill on hover in both themes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator(".lane-row").first()).toBeVisible();
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-control modifier-action primary";
    button.textContent = "Approve";
    button.id = "e2e-primary-probe";
    button.style.position = "fixed";
    button.style.insetBlockStart = "4rem";
    button.style.insetInlineStart = "4rem";
    button.style.zIndex = "9999";
    document.body.appendChild(button);
  });
  const probe = page.locator("#e2e-primary-probe");
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.mouse.move(0, 0);
    const rest = await probe.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await probe.hover();
    const hover = await probe.evaluate((el) => {
      const style = getComputedStyle(el);
      return { fill: style.backgroundColor, ink: style.color };
    });
    // The generic hover wash must never replace the primary fill (#20 review).
    expect(hover.fill, theme).toBe(rest);
    expect(contrastRatio(hover.ink, hover.fill), theme).toBeGreaterThanOrEqual(
      4.5,
    );
  }
});

test("every text on the fixed-dark transport reads in both themes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.locator(".lane-row").first()).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const samples = await page.locator(".transport").evaluate((transport) => {
      const parse = (value: string) => {
        const m = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
        const srgb = value.startsWith("color(srgb");
        const [r, g, b] = srgb ? m.slice(0, 3).map((c) => c * 255) : m;
        const a = (srgb ? m[3] : m[3]) ?? 1;
        return {
          r,
          g,
          b,
          a: value.includes("/") || value.startsWith("rgba") ? a : 1,
        };
      };
      const swatch = document.createElement("span");
      swatch.style.color = "var(--color-transport-top)";
      transport.appendChild(swatch);
      const strip = parse(getComputedStyle(swatch).color);
      swatch.remove();
      // Composite each ancestor fill (outermost first) over the strip.
      const backdrop = (el: Element) => {
        const chain: Element[] = [];
        for (
          let e: Element | null = el;
          e && e !== transport;
          e = e.parentElement
        ) {
          chain.unshift(e);
        }
        let base = strip;
        for (const e of chain) {
          const fill = parse(getComputedStyle(e).backgroundColor);
          if (fill.a > 0) {
            base = {
              r: fill.r * fill.a + base.r * (1 - fill.a),
              g: fill.g * fill.a + base.g * (1 - fill.a),
              b: fill.b * fill.a + base.b * (1 - fill.a),
              a: 1,
            };
          }
        }
        return `rgb(${base.r}, ${base.g}, ${base.b})`;
      };
      const out: { text: string; ink: string; back: string }[] = [];
      const walker = document.createTreeWalker(transport, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        const text = n.textContent?.trim();
        if (!el || !text) continue;
        const style = getComputedStyle(el);
        if (
          style.visibility === "hidden" ||
          el.closest("[aria-hidden='true'] .sr-only, .sr-only, .ui-menu-panel")
        )
          continue;
        if (!el.getClientRects().length) continue;
        out.push({ text, ink: style.color, back: backdrop(el) });
      }
      return out;
    });
    expect(samples.length, theme).toBeGreaterThan(3);
    for (const { text, ink, back } of samples) {
      expect(
        contrastRatio(ink, back),
        `${theme}: "${text}" ${ink} on ${back}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
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
    const pinTheme = (page: Page) => setTheme(page, theme);

    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    openContexts.push(desktopContext);
    const desktop = await desktopContext.newPage();
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
      await desktopContext.close();
    }

    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    openContexts.push(phoneContext);
    const phone = await phoneContext.newPage();
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
      await phoneContext.close();
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
    await setTheme(page, theme);
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
