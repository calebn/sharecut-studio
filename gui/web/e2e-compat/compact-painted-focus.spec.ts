import { expect } from "@playwright/test";
import { emptyEnvelopeProject } from "../e2e/envelopeCreationEvidence";
import {
  controlGeometry,
  pointerControl,
} from "../e2e/inspectorResponsiveEvidence";
import { test } from "../e2e/interactionEvidence";
import { rememberInspectorDetent } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { setTheme } from "../e2e/theme";

for (const width of [667, 844]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`painted focus ${width}x360 root32 ${theme}`, () => {
      test.use({ viewport: { width, height: 360 }, reducedMotion: "reduce" });
      test("every native compact Tab target paints its focus indicator inside actual clips", async ({
        page,
        browserName,
        receipts,
      }, info) => {
        await withShareableProject(
          async (projectPath) => {
            await page.addInitScript(
              (value) => localStorage.setItem("daw_theme", value),
              theme,
            );
            await rememberInspectorDetent(page, "full");
            await openHostShare(page, projectPath);
            if (width < 768)
              await pointerControl(
                page,
                page
                  .getByRole("navigation", { name: "Primary" })
                  .getByRole("button", { name: "Timeline", exact: true }),
                receipts,
              );
            await expect(
              page.locator(
                '.timeline-scroll .track-headers:not([aria-busy="true"])',
              ),
            ).toBeVisible();
            await setTheme(page, theme);
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            await page
              .locator(".lane-row .clip-hit")
              .first()
              .click({ position: { x: 20, y: 20 } });
            await page.locator("html").evaluate((html) => {
              html.style.fontSize = "32px";
            });
            const panel = page.locator(".bottom-sheet--compact");
            await expect(panel).toBeVisible();
            for (const name of ["Undo", "Redo", "Collapse to strip", "Close"]) {
              const header = await controlGeometry(
                panel.getByRole("button", { name, exact: true }),
              );
              receipts.push({
                checkpoint: "primary-header-before-recovery",
                observation: { name, header },
              });
              expect(header.fullyVisible).toBe(true);
              expect(header.hitsControl).toBe(true);
              expect(header.rect.width).toBeGreaterThanOrEqual(44);
              expect(header.rect.height).toBeGreaterThanOrEqual(44);
            }
            const targets = panel.locator(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
            );
            const count = await targets.count();
            const expected: string[] = [];
            for (let index = 0; index < count; index++) {
              const target = targets.nth(index);
              if (
                await target.evaluate(
                  (element) =>
                    !element.closest("[hidden], [inert]") &&
                    element.getBoundingClientRect().height > 0,
                )
              ) {
                const id = `native-target-${index}`;
                await target.evaluate(
                  (element, value) =>
                    element.setAttribute("data-focus-proof", value),
                  id,
                );
                expected.push(id);
              }
            }
            const seen = new Set<string>();
            const clipped: string[] = [];
            for (
              let step = 0;
              step < 150 && seen.size < expected.length;
              step++
            ) {
              await page.keyboard.press(
                browserName === "webkit" ? "Alt+Tab" : "Tab",
              );
              const active = page.locator(".bottom-sheet--compact :focus");
              if (!(await active.count())) continue;
              const id = await active.getAttribute("data-focus-proof");
              if (!id || seen.has(id)) continue;
              seen.add(id);
              await expect(active).toBeFocused();
              await page.waitForTimeout(50);
              const geometry = await controlGeometry(active);
              const paint = geometry.focusIndicator;
              const surrogate =
                paint.state === "outline" && paint.subject === "detent-grabber";
              const visible =
                paint.state === "outline" &&
                paint.full &&
                paint.visibleArea.state === "positive";
              receipts.push({
                checkpoint: "native-painted-indicator",
                observation: { id, surrogate, geometry, visible },
              });
              if (!visible) clipped.push(id);
              await info.attach(id, {
                body: await page.screenshot({
                  path: info.outputPath(`${id}.png`),
                }),
                contentType: "image/png",
              });
              if (!surrogate) {
                for (const measured of geometry.measured)
                  if (!measured.full) clipped.push(`${id}-label-or-control`);
              }
            }
            expect([...seen].sort()).toEqual(expected.sort());
            expect(clipped).toEqual([]);
          },
          undefined,
          emptyEnvelopeProject,
        );
      });
    });
  }
}
