import { writeFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { openPanel } from "../e2e/stageNav";
import { ownsStudioAxe } from "../e2e/studioAxeOwnership";
import { setTheme, withAppearance } from "../e2e/theme";

test.use({ hasTouch: true });

async function openPipeline(
  page: Page,
  projectPath: string,
  width: number,
  height: number,
  rootPx: number,
) {
  await page.setViewportSize({ width, height });
  await openHostShare(page, projectPath);
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = `${size}px`;
  }, rootPx);
  await openPanel(page, "pipeline");
  await expect(
    page.locator(".pipeline-vocabulary-field input").first(),
  ).toBeEnabled();
  // The step list renders after the toolbar; the page's height is settled once
  // its last step is there.
  await expect(page.locator(".pipeline-step-select").last()).toBeVisible();
}

async function hitPoint(target: Locator) {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let top = Math.max(0, rect.top);
    let bottom = Math.min(innerHeight, rect.bottom);
    let left = Math.max(0, rect.left);
    let right = Math.min(innerWidth, rect.right);
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top + parent.clientTop);
        bottom = Math.min(
          bottom,
          box.top + parent.clientTop + parent.clientHeight,
        );
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left + parent.clientLeft);
        right = Math.min(
          right,
          box.left + parent.clientLeft + parent.clientWidth,
        );
      }
    }
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      usable:
        bottom - top > 8 &&
        right - left > 8 &&
        (hit === element || element.contains(hit)),
      position: { x: x - rect.left, y: y - rect.top },
    };
  });
}

async function expectHit(target: Locator) {
  await expect.poll(async () => (await hitPoint(target)).usable).toBe(true);
  return (await hitPoint(target)).position;
}

for (const { cell: rootPx, theme, reducedMotion } of withAppearance([16, 32])) {
  test.describe(`Root text ${rootPx}px`, () => {
    test("Pipeline native targets stay clear in the Pipeline panel", async ({
      page,
      browserName,
    }, testInfo) => {
      await withShareableProject(async (projectPath) => {
        await page.emulateMedia({
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
        });
        await openPipeline(page, projectPath, 1195, 800, rootPx);
        await setTheme(page, theme);
        const panel = page.locator(".pipeline-panel");
        const mode = panel.getByRole("combobox", { name: "Mode", exact: true });
        await mode.click();
        await expectHit(mode);
        await mode.press("Escape");
        await expect(mode).toBeFocused();
        const summary = panel.locator(".pipeline-advanced-shortcuts summary");
        await summary.click();
        await expect(summary.locator("..")).toHaveAttribute("open");
        await expectHit(summary);
        const only = panel.getByRole("combobox", { name: "Only step" });
        await only.focus();
        await expectHit(only);
        await only.press("ArrowDown");
        const term = panel.locator(".pipeline-vocabulary-field input").first();
        await term.focus();
        await expectHit(term);
        await term.fill("toolbar fit draft");
        const shortPanelGeometry = await panel.evaluate((element) => ({
          rootFontSize: getComputedStyle(document.documentElement).fontSize,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollRange: element.scrollHeight - element.clientHeight,
          scrollTop: element.scrollTop,
          summary: element
            .querySelector("summary")
            ?.getBoundingClientRect()
            .toJSON(),
          input: element
            .querySelector(".pipeline-vocabulary-field input")
            ?.getBoundingClientRect()
            .toJSON(),
        }));
        const shortPanelGeometryPath = testInfo.outputPath(
          "short-panel-geometry.json",
        );
        writeFileSync(
          shortPanelGeometryPath,
          JSON.stringify(shortPanelGeometry, null, 2),
        );
        await testInfo.attach(`short-panel-${rootPx}px-geometry`, {
          contentType: "application/json",
          path: shortPanelGeometryPath,
        });
        const shortPanelScreenshotPath = testInfo.outputPath("short-panel.png");
        writeFileSync(shortPanelScreenshotPath, await page.screenshot());
        await testInfo.attach(`short-panel-${rootPx}px`, {
          contentType: "image/png",
          path: shortPanelScreenshotPath,
        });
        await summary.focus();
        await expectHit(summary);
        await summary.press("Enter");
        await expect(summary.locator("..")).not.toHaveAttribute("open");
        await expect(term).toHaveValue("toolbar fit draft");
        if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
          await expectPageAxeClean(page, ".pipeline-panel");
        }
      });
    });

    test("Pipeline retains a scrolled focused control across viewport resizes", async ({
      page,
      browserName,
    }, testInfo) => {
      test.fixme(
        browserName === "webkit",
        "Known failure on WebKit (#2462): the focused control loses its hit target after the resize to 1440",
      );
      await withShareableProject(async (projectPath) => {
        await page.emulateMedia({
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
        });
        await openPipeline(page, projectPath, 1440, 800, rootPx);
        await setTheme(page, theme);
        const panel = page.locator(".pipeline-panel");
        // The Prepare host is the page that scrolls; the panel sits inside it.
        const scroller = page.locator(".stage-host--prepare");
        const summary = panel.locator(".pipeline-advanced-shortcuts summary");
        const term = panel.locator(".pipeline-vocabulary-field input").first();
        await term.fill("retained draft");
        await summary.click();
        const only = panel.getByRole("combobox", { name: "Only step" });
        await only.selectOption({ index: 1 });
        await only.focus();
        // Focus reveals the select with a margin below it; Chrome keeps that
        // offset when a resize clamps and releases the range. Start from the
        // end of the page, the one position both anchors name.
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expectHit(only);
        const initialScroll = await scroller.evaluate((element) => ({
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollRange: element.scrollHeight - element.clientHeight,
          scrollTop: element.scrollTop,
        }));
        expect(initialScroll.scrollTop).toBeGreaterThan(0);
        const nodes = await panel.evaluateHandle((element) => ({
          toolbar: element.querySelector(".pipeline-toolbar"),
          panel: element,
          summary: element.querySelector("summary"),
          input: element.querySelector(".pipeline-vocabulary-field input"),
          only: element.querySelector(
            ".pipeline-advanced-shortcuts label:last-child select",
          ),
        }));
        const chosen = await only.inputValue();
        for (const height of [1600, 800]) {
          const beforeResize = await scroller.evaluate((element) => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollRange: element.scrollHeight - element.clientHeight,
            scrollTop: element.scrollTop,
          }));
          await page.setViewportSize({ width: 1440, height });
          await expect
            .poll(() => scroller.evaluate((element) => element.clientHeight))
            .not.toBe(beforeResize.clientHeight);
          const afterResize = await scroller.evaluate((element) => {
            const target = element.querySelector(
              ".pipeline-advanced-shortcuts label:last-child select",
            );
            const rect = target?.getBoundingClientRect();
            const hit = rect
              ? document.elementFromPoint(
                  Math.max(0, Math.min(innerWidth, rect.left + rect.width / 2)),
                  Math.max(
                    0,
                    Math.min(innerHeight, rect.top + rect.height / 2),
                  ),
                )
              : null;
            return {
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
              scrollRange: element.scrollHeight - element.clientHeight,
              scrollTop: element.scrollTop,
              focused: document.activeElement === target,
              target: rect?.toJSON(),
              hitTarget: hit === target || Boolean(target?.contains(hit)),
            };
          });
          const afterScrollRange =
            afterResize.scrollHeight - afterResize.clientHeight;
          const expectedScrollTopAnchors = {
            top: Math.min(beforeResize.scrollTop, afterScrollRange),
            bottom: Math.max(
              0,
              afterScrollRange -
                (beforeResize.scrollRange - beforeResize.scrollTop),
            ),
          };
          const chosenAnchor = (
            Object.entries(expectedScrollTopAnchors) as [
              keyof typeof expectedScrollTopAnchors,
              number,
            ][]
          ).find(
            ([, expected]) => Math.abs(afterResize.scrollTop - expected) <= 0.5,
          )?.[0];
          const geometryPath = testInfo.outputPath(
            `resize-${height}-geometry.json`,
          );
          writeFileSync(
            geometryPath,
            JSON.stringify(
              {
                height,
                beforeResize,
                afterResize,
                expectedScrollTopAnchors,
                chosenAnchor,
                actualScrollTop: afterResize.scrollTop,
              },
              null,
              2,
            ),
          );
          await testInfo.attach(`resize-${height}-geometry`, {
            contentType: "application/json",
            path: geometryPath,
          });
          const screenshotPath = testInfo.outputPath(`resize-${height}.png`);
          writeFileSync(screenshotPath, await page.screenshot());
          await testInfo.attach(`resize-${height}`, {
            contentType: "image/png",
            path: screenshotPath,
          });
          await expect(only).toBeFocused();
          expect(afterResize.focused).toBe(true);
          expect(
            chosenAnchor,
            `actual scrollTop ${afterResize.scrollTop} should match a clamped top or bottom anchor`,
          ).toBeDefined();
          expect(afterResize.hitTarget).toBe(true);
          await expectHit(only);
          await expect(summary.locator("..")).toHaveAttribute("open");
          await expect(only).toHaveValue(chosen);
          await expect(term).toHaveValue("retained draft");
          expect(
            await panel.evaluate(
              (element, saved) =>
                element.querySelector(".pipeline-toolbar") === saved.toolbar &&
                element === saved.panel &&
                element.querySelector("summary") === saved.summary &&
                element.querySelector(".pipeline-vocabulary-field input") ===
                  saved.input &&
                element.querySelector(
                  ".pipeline-advanced-shortcuts label:last-child select",
                ) === saved.only,
              nodes,
            ),
          ).toBe(true);
        }
        await nodes.dispose();
        if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
          await expectPageAxeClean(page, ".pipeline-panel");
        }
      });
    });
  });
}

test("Pipeline keeps an oversized native control targetable", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openPipeline(page, projectPath, 1440, 1200, 16);
    const panel = page.locator(".pipeline-panel");
    const term = panel.locator(".pipeline-vocabulary-field input").first();
    const panelHeight = await panel.evaluate((element) => element.clientHeight);
    await term.evaluate((element, height) => {
      element.style.height = `${height * 2}px`;
    }, panelHeight);
    await term.focus();
    await term.click({ position: await expectHit(term) });
    await term.press("x");
    await expect(term).toHaveValue("x");
  });
});

for (const { cell, theme, reducedMotion } of withAppearance([
  { width: 390, height: 844, rootPx: 16 },
  { width: 390, height: 844, rootPx: 32 },
  { width: 1180, height: 620, rootPx: 16 },
])) {
  test.describe(`${cell.width}x${cell.height}, ${cell.rootPx}px text`, () => {
    test("Pipeline native flow keeps phone and coarse-pointer targets usable", async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        await page.emulateMedia({
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
        });
        await openPipeline(
          page,
          projectPath,
          cell.width,
          cell.height,
          cell.rootPx,
        );
        await setTheme(page, theme);
        const panel = page.locator(".pipeline-panel");
        await expect(panel).toHaveCSS("overflow-y", "auto");
        const summary = panel.locator(".pipeline-advanced-shortcuts summary");
        await summary.click();
        await expectHit(summary);
        await summary.press("Tab");
        const from = panel.getByRole("combobox", { name: "From step" });
        await expect(from).toBeFocused();
        await expectHit(from);
        await from.press("ArrowDown");
      });
    });
  });
}
