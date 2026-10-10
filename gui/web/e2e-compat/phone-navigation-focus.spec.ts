import { expect } from "@playwright/test";
import { emptyEnvelopeProject } from "../e2e/envelopeCreationEvidence";
import { controlGeometry } from "../e2e/inspectorResponsiveEvidence";
import { test } from "../e2e/interactionEvidence";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { setTheme } from "../e2e/theme";
import { json, shot } from "../e2e/touchTimeline";

for (const rootPx of [16, 32]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`phone navigation focus root${rootPx} ${theme}`, () => {
      test.use({
        viewport: { width: 390, height: 844 },
        reducedMotion: "reduce",
      });

      test("native Tab keeps every Primary navigation indicator inside its clip", async ({
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
            await openHostShare(page, projectPath);
            await setTheme(page, theme);
            await page.locator("html").evaluate((html, size) => {
              html.style.fontSize = `${size}px`;
            }, rootPx);
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );

            const navigation = page.getByRole("navigation", {
              name: "Primary",
            });
            await expect(navigation).toBeVisible();
            const buttons = await navigation.getByRole("button").all();
            expect(buttons.length).toBeGreaterThan(0);
            const measured = [];
            const failures: string[] = [];
            const labels = await Promise.all(
              buttons.map(async (button) =>
                (await button.innerText()).replaceAll("\n", " "),
              ),
            );
            const focusableCount = await page
              .locator(
                'a[href], area[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), iframe, [tabindex]:not([tabindex="-1"])',
              )
              .count();
            const tabKey = browserName === "webkit" ? "Alt+Tab" : "Tab";
            const seen = new Set<number>();
            let cycleStartMarked = false;

            for (let step = 0; step <= focusableCount; step++) {
              await page.keyboard.press(tabKey);
              if (
                cycleStartMarked &&
                (await page
                  .locator('[data-phone-focus-cycle-start="true"]')
                  .evaluate((element) => element === document.activeElement))
              )
                break;
              if (!cycleStartMarked) {
                await page.evaluate(() =>
                  document.activeElement?.setAttribute(
                    "data-phone-focus-cycle-start",
                    "true",
                  ),
                );
                cycleStartMarked = true;
              }

              const index = await navigation
                .locator("button")
                .evaluateAll((elements) =>
                  elements.findIndex(
                    (element) => element === document.activeElement,
                  ),
                );
              if (index < 0 || seen.has(index)) continue;

              seen.add(index);
              const button = buttons[index]!;
              const label = labels[index]!;
              const geometry = await controlGeometry(button);
              measured.push({ label, geometry });
              receipts.push({
                checkpoint: "phone-navigation-native-focus",
                observation: { browserName, rootPx, theme, label, geometry },
              });
              await shot(info, page, `nav-${index}-${theme}-root${rootPx}`);
              const indicator = geometry.focusIndicator;
              if (
                indicator.state !== "outline" ||
                !indicator.full ||
                indicator.visibleArea.state !== "positive" ||
                !geometry.measured[0]?.full
              )
                failures.push(label);
              if (seen.size === buttons.length) break;
            }

            json(info, "phone-navigation-focus", {
              browserName,
              viewport: { width: 390, height: 844 },
              rootPx,
              theme,
              expectedLabels: labels,
              observedLabels: [...seen].map((index) => labels[index]),
              measured,
              failures,
              receipts,
            });
            expect([...seen].map((index) => labels[index]).sort()).toEqual(
              [...labels].sort(),
            );
            expect(failures).toEqual([]);
          },
          undefined,
          emptyEnvelopeProject,
        );
      });
    });
  }
}
