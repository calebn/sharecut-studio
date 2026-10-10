import { expect } from "@playwright/test";
import { emptyEnvelopeProject } from "../e2e/envelopeCreationEvidence";
import {
  captureInspector,
  controlGeometry,
  exposeControl,
  nativeTabTo,
  pointerControl,
} from "../e2e/inspectorResponsiveEvidence";
import { test } from "../e2e/interactionEvidence";
import { rememberInspectorDetent } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { setTheme } from "../e2e/theme";

for (const viewport of [
  { width: 667, height: 360 },
  { width: 844, height: 390 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`compact form ${viewport.width}x${viewport.height} root32 ${theme}`, () => {
      test.use({ viewport, reducedMotion: "reduce" });
      test("scrolled fades and pinned actions retain pointer and keyboard ownership", async ({
        page,
        receipts,
        browserName,
      }, info) => {
        await withShareableProject(
          async (projectPath) => {
            await rememberInspectorDetent(page, "full");
            await openHostShare(page, projectPath);
            if (viewport.width < 768) {
              await pointerControl(
                page,
                page
                  .getByRole("navigation", { name: "Primary" })
                  .getByRole("button", { name: "Timeline", exact: true }),
                receipts,
              );
            }
            await expect(
              page.locator(
                '.timeline-scroll .track-headers:not([aria-busy="true"])',
              ),
            ).toBeVisible();
            await setTheme(page, theme);
            await page
              .locator(".lane-row .clip-hit")
              .first()
              .click({ position: { x: 20, y: 20 } });
            await expect(page.locator(".modifier-badge")).toHaveText("Clip");
            await page.locator("html").evaluate((html) => {
              html.style.fontSize = "32px";
            });
            const chrome = page.locator(".bottom-sheet-chrome");
            for (const name of ["Fade in ms", "Fade out ms"]) {
              const field = page.getByLabel(name, { exact: true });
              await exposeControl(page, field, receipts);
              await nativeTabTo(
                page,
                field,
                receipts,
                browserName === "webkit" ? "Alt+Tab" : "Tab",
              );
              const geometry = await controlGeometry(field);
              const chromeBottom = await chrome.evaluate(
                (element) => element.getBoundingClientRect().bottom,
              );
              receipts.push({
                checkpoint: `${name}-below-chrome`,
                observation: { geometry, chromeBottom },
              });
              expect(geometry.hitsControl).toBe(true);
              for (const item of geometry.measured) {
                expect(item.rect.top).toBeGreaterThanOrEqual(chromeBottom);
                expect(item.full).toBe(true);
              }
            }
            const fade = page.getByLabel("Fade out ms", { exact: true });
            await fade.focus();
            await fade.press("ArrowRight");
            await page.route("**/api/document/command*", async (route) => {
              const body = route.request().postDataJSON() as { type: string };
              if (body.type === "UndoHistory") {
                await route.fulfill({
                  status: 409,
                  contentType: "application/json",
                  headers: { "x-sharecut-error-code": "history_stale" },
                  body: JSON.stringify({ detail: "Project changed" }),
                });
              } else {
                await route.continue();
              }
            });
            await page
              .locator(".bottom-sheet-header")
              .getByRole("button", { name: "Undo", exact: true })
              .click();
            const feedback = page.locator(
              ".ui-toast-region--inspector-flow .ui-toast",
            );
            await expect(feedback).toBeVisible();
            await nativeTabTo(
              page,
              fade,
              receipts,
              browserName === "webkit" ? "Alt+Tab" : "Tab",
            );
            await expect(fade).toBeFocused();
            const fadeGeometry = await controlGeometry(fade);
            const feedbackBox = await feedback.boundingBox();
            expect(feedbackBox).not.toBeNull();
            expect(fadeGeometry.hitsControl).toBe(true);
            expect(fadeGeometry.rect.top).toBeGreaterThanOrEqual(
              (feedbackBox?.y ?? 0) + (feedbackBox?.height ?? 0),
            );
            for (const action of await feedback.getByRole("button").all()) {
              await exposeControl(page, action, receipts);
              const geometry = await controlGeometry(action);
              expect(geometry.hitsControl).toBe(true);
              expect(geometry.rect.width).toBeGreaterThanOrEqual(88);
              expect(geometry.rect.height).toBeGreaterThanOrEqual(88);
            }
            for (const name of ["Undo", "Redo", "Collapse to strip", "Close"]) {
              const action = page
                .locator(".bottom-sheet-header")
                .getByRole("button", { name, exact: true });
              await nativeTabTo(
                page,
                action,
                receipts,
                browserName === "webkit" ? "Alt+Tab" : "Tab",
              );
              const geometry = await controlGeometry(action);
              expect(geometry.hitsControl).toBe(true);
              expect(geometry.rect.width).toBeGreaterThanOrEqual(88);
              expect(geometry.rect.height).toBeGreaterThanOrEqual(88);
            }
            await captureInspector(
              page,
              info,
              receipts,
              "scrolled-clip-keyboard-and-header",
            );
          },
          undefined,
          emptyEnvelopeProject,
        );
      });
    });
  }
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  for (const detent of ["peek", "half", "full"] as const) {
    test.describe(`covered rail ${viewport.width}x${viewport.height} ${detent}`, () => {
      test.use({ viewport, reducedMotion: "reduce" });
      test("native traversal skips covered tools and Close restores them", async ({
        page,
        browserName,
      }) => {
        await withShareableProject(
          async (projectPath) => {
            await rememberInspectorDetent(page, detent);
            await openHostShare(page, projectPath);
            if (viewport.width < 768) {
              await page
                .getByRole("navigation", { name: "Primary" })
                .getByRole("button", { name: "Timeline", exact: true })
                .click();
            }
            await expect(
              page.locator(
                '.timeline-scroll .track-headers:not([aria-busy="true"])',
              ),
            ).toBeVisible();
            const rail = page.locator(".editing-tool-rail");
            const before = await rail.boundingBox();
            await page
              .locator(".lane-row .clip-hit")
              .first()
              .click({ position: { x: 20, y: 20 } });
            await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
            await expect(rail).toHaveAttribute("inert", "");
            expect((await rail.boundingBox())?.height).toBe(before?.height);
            const key = browserName === "webkit" ? "Alt+Tab" : "Tab";
            let visitedHeader = false;
            for (let step = 0; step < 80; step++) {
              await page.keyboard.press(key);
              const focus = await page.evaluate(() => ({
                rail: !!document.activeElement?.closest(".editing-tool-rail"),
                header: !!document.activeElement?.closest(
                  ".bottom-sheet-header",
                ),
              }));
              expect(focus.rail).toBe(false);
              visitedHeader ||= focus.header;
            }
            expect(visitedHeader).toBe(true);
            await page
              .locator(".bottom-sheet-header")
              .getByRole("button", { name: "Close", exact: true })
              .click();
            await expect(rail).not.toHaveAttribute("inert");
            const undo = rail.getByRole("button", {
              name: "Undo",
              exact: true,
            });
            let reachedUndo = false;
            for (let step = 0; step < 100; step++) {
              await page.keyboard.press(key);
              reachedUndo = await undo.evaluate(
                (element) => element === document.activeElement,
              );
              if (reachedUndo) break;
            }
            expect(reachedUndo).toBe(true);
          },
          undefined,
          emptyEnvelopeProject,
        );
      });
    });
  }
}
