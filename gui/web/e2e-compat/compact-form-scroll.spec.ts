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
              await nativeTabTo(page, field, receipts);
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
            for (const name of ["Undo", "Redo", "Collapse to strip", "Close"]) {
              const action = page.getByRole("button", { name, exact: true });
              await nativeTabTo(page, action, receipts);
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
