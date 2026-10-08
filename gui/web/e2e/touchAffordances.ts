import fs from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import {
  controlGeometry,
  pointerControl,
  wheelInspector,
} from "./inspectorResponsiveEvidence";
import { openHostProject } from "./overlayReachability";
import { openPhoneTimeline } from "./phoneTimeline";
import { setTheme, type Theme } from "./theme";

export type TouchSheetViewport = {
  width: number;
  height: number;
  sheetExpected: boolean;
  textScale?: boolean;
  requireBodyOverflow?: boolean;
};

type ShellChromeGeometry = {
  shell: string | null;
  mobileNavBox: Awaited<ReturnType<Locator["boundingBox"]>>;
  bottomTabsBox: Awaited<ReturnType<Locator["boundingBox"]>>;
};

type SheetGeometry = {
  sheetBox: Awaited<ReturnType<Locator["boundingBox"]>>;
  shellChrome: ShellChromeGeometry;
  headerBox: Awaited<ReturnType<Locator["boundingBox"]>>;
  titleBox: Awaited<ReturnType<Locator["boundingBox"]>>;
  bodyBox: Awaited<ReturnType<Locator["boundingBox"]>>;
  resizeBox: Awaited<ReturnType<Locator["boundingBox"]>>;
  closeBox: Awaited<ReturnType<Locator["boundingBox"]>>;
};

export async function exerciseTouchSheetAffordances(
  page: Page,
  viewport: TouchSheetViewport,
  theme: Theme,
  reducedMotion: boolean,
): Promise<void> {
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  await page.emulateMedia({
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await openHostProject(page);
  if (viewport.width <= 767) await openPhoneTimeline(page);
  else if (viewport.width <= 1100) {
    const timelineTab = page.getByRole("button", {
      name: "Timeline",
      exact: true,
    });
    if (await timelineTab.count()) await timelineTab.first().click();
  }
  await setTheme(page, theme);
  const rootFontSizeBefore = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  let rootFontSizeAfter = rootFontSizeBefore;
  if (viewport.textScale) {
    rootFontSizeAfter = await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = `${fontSize * 2}px`;
      return Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
    }, rootFontSizeBefore);
    expect(rootFontSizeAfter).toBe(rootFontSizeBefore * 2);
    expect(rootFontSizeAfter).toBeGreaterThan(0);
  }

  const savedProject = fs.readFileSync(e2eProjectPath, "utf8");
  const localPreferences = await browserStorageState(page);
  const documentCommands: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/document/command") {
      documentCommands.push(request.postData() ?? "");
    }
  });

  // A track opens the plain inspector sheet; a timeline target on a phone
  // opens the compact drawer instead, which touch-peek.spec.ts covers. Enter
  // keeps focus on the button, which a WebKit click does not.
  const trigger = page.locator(".track-header-open").first();
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  const sheet = page.locator(".bottom-sheet");
  if (!viewport.sheetExpected) {
    await expect(sheet).toHaveCount(0);
    await test.info().attach("desktop-no-sheet.png", {
      body: await page.screenshot({ type: "png" }),
      contentType: "image/png",
    });
    expect(documentCommands).toEqual([]);
    expect(fs.readFileSync(e2eProjectPath, "utf8")).toBe(savedProject);
    return;
  }

  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".bottom-sheet-grab")).toHaveCount(0);
  await sheet.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  const close = sheet.getByRole("button", { name: "Close" });
  const resize = sheet.locator(".bottom-sheet-resize-action");
  await expect(resize).toHaveAccessibleName("Expand");
  await expect(close).toBeFocused();
  const geometry = async (): Promise<SheetGeometry> => {
    const shellChrome: ShellChromeGeometry = {
      shell: await page.locator("html").getAttribute("data-shell"),
      mobileNavBox: await optionalBoundingBox(page.locator(".mobile-nav")),
      bottomTabsBox: await optionalBoundingBox(page.locator(".bottom-tabs")),
    };
    const sheetBox = await sheet.boundingBox();
    const closeBox = await close.boundingBox();
    const headerBox = await sheet.locator(".bottom-sheet-header").boundingBox();
    const titleBox = await sheet.locator(".bottom-sheet-title").boundingBox();
    const bodyBox = await sheet.locator(".bottom-sheet-body").boundingBox();
    return {
      sheetBox,
      shellChrome,
      headerBox,
      titleBox,
      bodyBox,
      resizeBox: await resize.boundingBox(),
      closeBox,
    };
  };
  const before = await geometry();
  await test.info().attach("sheet-half.png", {
    body: await page.screenshot({ type: "png" }),
    contentType: "image/png",
  });
  await test.info().attach("sheet-half-geometry.json", {
    body: Buffer.from(JSON.stringify(before, null, 2)),
    contentType: "application/json",
  });
  const halfBox = before.sheetBox;
  if (halfBox === null) throw new Error("The visible sheet has no geometry");
  const headerBox = before.headerBox;
  const bodyBox = before.bodyBox;
  const resizeBox = before.resizeBox;
  const closeBox = before.closeBox;
  if (headerBox === null || bodyBox === null) {
    throw new Error("The sheet header or body has no geometry");
  }
  if (resizeBox === null || closeBox === null) {
    throw new Error("A visible sheet action has no geometry");
  }
  expect(bodyBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
  const bodyGeometry = await controlGeometry(
    sheet.locator(".bottom-sheet-body"),
  );
  const bodyArea = bodyGeometry.measured[0];
  expect(
    Math.min(bodyArea.rect.bottom, bodyArea.clip.bottom) -
      Math.max(bodyArea.rect.top, bodyArea.clip.top),
  ).toBeGreaterThan(0);
  if (viewport.textScale) {
    const titleBox = before.titleBox;
    if (titleBox === null) throw new Error("The scaled sheet title is missing");
    // Beside the resize action, or wrapped above it when they cannot share a row.
    const clearOfResize =
      titleBox.x + titleBox.width <= resizeBox.x + 1 ||
      titleBox.y + titleBox.height <= resizeBox.y + 1;
    expect({ clearOfResize, titleBox, resizeBox }).toMatchObject({
      clearOfResize: true,
    });
    const titleOverflow = await sheet
      .locator(".bottom-sheet-title")
      .evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
    expect(titleOverflow.scrollWidth).toBeLessThanOrEqual(
      titleOverflow.clientWidth,
    );
  }
  expectExpectedShellChrome(before.shellChrome);
  expect(resizeBox.height).toBeGreaterThanOrEqual(44);
  expect(resizeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  expectSheetClearsShellChrome(halfBox, before.shellChrome);
  await expectPageAxeClean(page, ".bottom-sheet-chrome");

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const focusAfterEscape = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    className:
      document.activeElement instanceof HTMLElement
        ? document.activeElement.className
        : null,
    label:
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute("aria-label")
        : null,
  }));
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(sheet).toBeVisible();
  await sheet.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  const reopened = await sheet.boundingBox();
  if (reopened === null) throw new Error("The reopened sheet has no geometry");
  await resize.click();
  await expect(resize).toHaveAccessibleName("Collapse");
  await expect
    .poll(async () => (await sheet.boundingBox())?.height ?? 0)
    .toBeGreaterThan(reopened.height);
  const expandedGeometry = await geometry();
  await test.info().attach("sheet-full.png", {
    body: await page.screenshot({ type: "png" }),
    contentType: "image/png",
  });
  await test.info().attach("sheet-geometry.json", {
    body: Buffer.from(
      JSON.stringify(
        {
          viewport: { width: viewport.width, height: viewport.height },
          theme,
          reducedMotion,
          rootTextScale: viewport.textScale
            ? {
                method:
                  "CSS root font size doubled; this does not emulate browser zoom or an operating-system text setting",
                beforePx: rootFontSizeBefore,
                afterPx: rootFontSizeAfter,
              }
            : null,
          half: before,
          full: expandedGeometry,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
  await expectPageAxeClean(page, ".bottom-sheet-chrome");
  const fullBox = await sheet.boundingBox();
  if (fullBox === null) throw new Error("The expanded sheet has no geometry");
  if (!viewport.requireBodyOverflow) {
    await resize.click();
    await expect(resize).toHaveAccessibleName("Expand");
    await expect
      .poll(async () => (await sheet.boundingBox())?.height ?? 0)
      .toBeLessThan(fullBox.height);
    await expect
      .poll(async () => (await sheet.boundingBox())?.height ?? 0)
      .toBeCloseTo(halfBox.height, 0);
  }
  const collapsedHeight = viewport.requireBodyOverflow
    ? null
    : ((await sheet.boundingBox())?.height ?? null);

  const scrollRegion = sheet;
  const scrollState = await scrollRegion.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY,
    canScroll:
      element.clientHeight > 0 &&
      element.scrollHeight > element.clientHeight + 1 &&
      ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
  }));
  expect(scrollState.scrollTop).toBe(0);
  const bodyOverflows = scrollState.canScroll;
  if (viewport.requireBodyOverflow) {
    expect(scrollState.clientHeight).toBeGreaterThan(0);
    expect(scrollState.scrollHeight).toBeGreaterThan(
      scrollState.clientHeight + 1,
    );
    expect(["auto", "scroll"]).toContain(scrollState.overflowY);
    await expect(
      scrollRegion.locator("input, select, button").first(),
    ).toBeVisible();
  }
  if (bodyOverflows) {
    await wheelInspector(page, [], 240);
    await expect
      .poll(() => scrollRegion.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollState.scrollTop);
    await expect
      .poll(async () => (await sheet.boundingBox())?.height ?? 0)
      .toBeCloseTo(
        viewport.requireBodyOverflow ? fullBox.height : halfBox.height,
        0,
      );
  }

  await pointerControl(page, close, []);
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const focusAfterClose = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    className:
      document.activeElement instanceof HTMLElement
        ? document.activeElement.className
        : null,
    label:
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute("aria-label")
        : null,
  }));
  await test.info().attach("sheet-observation.json", {
    body: Buffer.from(
      JSON.stringify(
        {
          viewport: { width: viewport.width, height: viewport.height },
          theme,
          reducedMotion,
          rootTextScale: viewport.textScale
            ? {
                method:
                  "CSS root font size doubled; this does not emulate browser zoom or an operating-system text setting",
                beforePx: rootFontSizeBefore,
                afterPx: rootFontSizeAfter,
              }
            : null,
          focusAfterEscape,
          focusAfterClose,
          half: before,
          full: expandedGeometry,
          collapsedHeight,
          nestedBodyOverflow: bodyOverflows,
          bodyScroll: scrollState,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
  expect(await browserStorageState(page)).toBe(localPreferences);
  expect(documentCommands).toEqual([]);
  expect(fs.readFileSync(e2eProjectPath, "utf8")).toBe(savedProject);
  if (viewport.width <= 767) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Gestures", exact: true }).click();
    const gestures = page.getByRole("dialog", { name: "Gestures" });
    await expect(gestures).toContainText(
      "Undo: Undo the last action. Optional Sharecut shortcut.",
    );
    await page.keyboard.press("Escape");
    await expect(gestures).toHaveCount(0);
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function optionalBoundingBox(locator: Locator) {
  if ((await locator.count()) === 0) return null;
  const first = locator.first();
  if (!(await first.isVisible())) return null;
  return first.boundingBox();
}

function expectExpectedShellChrome(chrome: ShellChromeGeometry): void {
  if (chrome.shell === "phone") expect(chrome.mobileNavBox).not.toBeNull();
  if (chrome.shell === "tablet") expect(chrome.bottomTabsBox).not.toBeNull();
}

function expectSheetClearsShellChrome(
  sheetBox: NonNullable<SheetGeometry["sheetBox"]>,
  chrome: ShellChromeGeometry,
): void {
  for (const chromeBox of [chrome.mobileNavBox, chrome.bottomTabsBox]) {
    if (chromeBox !== null) {
      expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(chromeBox.y + 1);
    }
  }
}

async function browserStorageState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const entries = (storage: Storage): Array<[string, string | null]> =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index);
        return key === null ? null : [key, storage.getItem(key)];
      })
        .filter((entry): entry is [string, string | null] => entry !== null)
        .sort(([first], [second]) => first.localeCompare(second));
    return JSON.stringify({
      local: entries(localStorage),
      session: entries(sessionStorage),
    });
  });
}
