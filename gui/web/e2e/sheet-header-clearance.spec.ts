import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { openHostProject } from "./overlayReachability";
import { openPhoneTimeline } from "./phoneTimeline";
import { openProjectDialog } from "./stageNav";
import { setTheme } from "./theme";

const HEADER_END = "--frame-header-end";

async function openPhoneContext(
  browser: Browser,
  info: TestInfo,
  viewport: { width: number; height: number },
  coarse: boolean,
) {
  const contextOptions: BrowserContextOptions = {
    baseURL: info.project.use.baseURL as string,
    viewport,
    hasTouch: coarse,
    isMobile: coarse,
    reducedMotion: "reduce",
    storageState: info.project.use
      .storageState as BrowserContextOptions["storageState"],
  };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await openHostProject(page);
  await openPhoneTimeline(page);
  await setTheme(page, "light");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return { context, page };
}

async function openFullInvite(page: Page) {
  await openProjectDialog(page, "share");
  const sheet = page.getByRole("dialog", { name: "Invite", exact: true });
  await expect(sheet).toBeVisible();
  if (
    !(await sheet.evaluate((element) =>
      element.classList.contains("bottom-sheet--full"),
    ))
  ) {
    await sheet
      .getByRole("button", { name: "Expand to full height", exact: true })
      .click();
  }
  await expect(sheet).toHaveClass(/bottom-sheet--full/);
  await sheet.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  return sheet;
}

async function inspectClearance(page: Page) {
  return page.evaluate((property) => {
    const header = document.querySelector<HTMLElement>(".stage-frame-header");
    const panel = document.querySelector<HTMLElement>(".bottom-sheet");
    const root = document.querySelector<HTMLElement>(".bottom-sheet-root");
    if (!header || !panel || !root) {
      throw new Error(
        "Actual Invite header and bottom-sheet geometry must be present",
      );
    }
    const headerRect = header.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const buttons = [...header.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          getComputedStyle(button).visibility !== "hidden"
        );
      })
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          name: button.getAttribute("aria-label") ?? button.textContent?.trim(),
          centerOwned: !!hit && (hit === button || button.contains(hit)),
          hit:
            hit?.getAttribute("aria-label") ??
            hit?.textContent?.trim() ??
            hit?.tagName,
        };
      });
    return {
      headerBottom: headerRect.bottom,
      panelTop: panelRect.top,
      rootTop: Number.parseFloat(getComputedStyle(root).top),
      publishedBoundary: getComputedStyle(document.documentElement)
        .getPropertyValue(property)
        .trim(),
      buttons,
      shell: document.documentElement.dataset.shell,
      coarse: matchMedia("(pointer: coarse)").matches,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, HEADER_END);
}

for (const viewport of [
  { width: 360, height: 800 },
  { width: 667, height: 360 },
]) {
  for (const coarse of [false, true]) {
    for (const scale of [1, 2]) {
      test(`actual Invite sheet clears the header at ${viewport.width}x${viewport.height}, ${coarse ? "coarse" : "fine"} pointer, root ${scale}`, async ({
        browser,
      }, info) => {
        const { context, page } = await openPhoneContext(
          browser,
          info,
          viewport,
          coarse,
        );
        try {
          const font = await page.evaluate((factor) => {
            const before = Number.parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            );
            document.documentElement.style.fontSize = `${before * factor}px`;
            return {
              before,
              after: Number.parseFloat(
                getComputedStyle(document.documentElement).fontSize,
              ),
            };
          }, scale);
          expect(font.after).toBe(font.before * scale);

          let sheet = await openFullInvite(page);
          const first = await inspectClearance(page);
          expect(first.shell).toBe("phone");
          expect(first.coarse).toBe(coarse);
          expect(first.publishedBoundary).toMatch(/^\d+(?:\.\d+)?px$/);
          expect(first.panelTop, JSON.stringify(first)).toBeGreaterThanOrEqual(
            first.headerBottom - 1,
          );
          expect(first.buttons.length).toBeGreaterThan(0);
          expect(
            first.buttons.filter((button) => !button.centerOwned),
            JSON.stringify(first),
          ).toEqual([]);

          await sheet
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(sheet).toBeHidden();
          sheet = await openFullInvite(page);
          const reopened = await inspectClearance(page);
          expect(
            reopened.panelTop,
            JSON.stringify(reopened),
          ).toBeGreaterThanOrEqual(reopened.headerBottom - 1);
          expect(
            reopened.buttons.filter((button) => !button.centerOwned),
            JSON.stringify(reopened),
          ).toEqual([]);

          await page.setViewportSize({ width: 820, height: 800 });
          await expect
            .poll(() => page.locator("html").getAttribute("data-shell"))
            .toBe("tablet");
          await expect
            .poll(() =>
              page.evaluate(
                (property) =>
                  document.documentElement.style.getPropertyValue(property),
                HEADER_END,
              ),
            )
            .toBe("");

          await page.setViewportSize({ width: 1440, height: 900 });
          await expect
            .poll(() => page.locator("html").getAttribute("data-shell"))
            .toBe("desktop");
          expect(
            await page.evaluate(
              (property) =>
                document.documentElement.style.getPropertyValue(property),
              HEADER_END,
            ),
          ).toBe("");
        } finally {
          await context.close();
        }
      });
    }
  }
}

for (const coarse of [false, true]) {
  test(`${coarse ? "coarse" : "fine"} phone pan and keyboard metadata preserve placement precedence`, async ({
    browser,
  }, info) => {
    const { context, page } = await openPhoneContext(
      browser,
      info,
      { width: 360, height: 800 },
      coarse,
    );
    try {
      await openFullInvite(page);
      const initial = await inspectClearance(page);
      await page.evaluate(() => {
        const root = document.documentElement;
        root.dataset.viewportPan = "";
        root.style.setProperty("--viewport-pan-top", "17px");
        root.style.setProperty("--viewport-pan-height", "100dvh");
      });
      await expect
        .poll(async () => {
          const geometry = await inspectClearance(page);
          return Math.abs(geometry.panelTop - geometry.headerBottom) <= 1;
        })
        .toBe(true);
      const panned = await inspectClearance(page);
      expect(panned.rootTop - initial.rootTop).toBe(coarse ? 17 : 0);
      expect(panned.headerBottom - initial.headerBottom).toBe(coarse ? 17 : 0);
      await page.evaluate(() => {
        const root = document.documentElement;
        root.dataset.keyboard = "open";
        root.style.setProperty("--visual-viewport-top", "23px");
        root.style.setProperty("--keyboard-inset", "271px");
      });
      const keyboard = await page
        .locator(".bottom-sheet-root")
        .evaluate((element) => ({
          top: getComputedStyle(element).top,
          bottom: getComputedStyle(element).bottom,
        }));
      expect(keyboard).toEqual({ top: "23px", bottom: "271px" });
      await page.evaluate(() => {
        const root = document.documentElement;
        delete root.dataset.keyboard;
        delete root.dataset.viewportPan;
        for (const property of [
          "--visual-viewport-top",
          "--keyboard-inset",
          "--viewport-pan-top",
          "--viewport-pan-height",
        ])
          root.style.removeProperty(property);
      });
      const restored = await inspectClearance(page);
      expect(restored.panelTop).toBeGreaterThanOrEqual(
        restored.headerBottom - 1,
      );
      expect(restored.rootTop).toBe(initial.rootTop);
    } finally {
      await context.close();
    }
  });
}

for (const width of [820, 1440]) {
  test(`wide Invite route at ${width}px does not publish phone header clearance`, async ({
    browser,
  }, info) => {
    const { context, page } = await openPhoneContext(
      browser,
      info,
      { width, height: 900 },
      false,
    );
    try {
      await openProjectDialog(page, "share");
      await expect(
        page.getByRole("dialog", { name: "Invite", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          (property) =>
            document.documentElement.style.getPropertyValue(property),
          HEADER_END,
        ),
      ).toBe("");
      expect(await page.locator("html").getAttribute("data-shell")).toBe(
        width === 820 ? "tablet" : "desktop",
      );
    } finally {
      await context.close();
    }
  });
}
