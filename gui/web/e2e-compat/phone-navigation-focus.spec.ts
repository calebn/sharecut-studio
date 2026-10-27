import { expect, type Locator } from "@playwright/test";
import { emptyEnvelopeProject } from "../e2e/envelopeCreationEvidence";
import { controlGeometry } from "../e2e/inspectorResponsiveEvidence";
import { test } from "../e2e/interactionEvidence";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { setTheme, withAppearance } from "../e2e/theme";
import { json, shot } from "../e2e/touchTimeline";

for (const { cell: rootPx, theme } of withAppearance([16, 32])) {
  test.describe(`phone navigation focus root${rootPx} ${theme}`, () => {
    test.use({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });

    test("native Tab keeps every Stage bar indicator inside its clip", async ({
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

          // The Stage bar is one roving tab stop: native Tab reaches it, and
          // the arrows walk its tabs. Too narrow for the bar (large text on a
          // phone), it folds into the header's Stage menu: native Tab reaches
          // that button, and the arrows walk the menu's items.
          const navigation = page.getByRole("tablist", { name: "Stages" });
          const stageMenu = page.getByRole("button", { name: /^Stage menu, / });
          await expect(navigation.or(stageMenu)).toBeVisible();
          const folded = await stageMenu.isVisible();
          if (folded) {
            const tabKey = browserName === "webkit" ? "Alt+Tab" : "Tab";
            const focusableCount = await page
              .locator(
                'a[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
              )
              .count();
            const isFocused = () =>
              stageMenu.evaluate((el) => el === document.activeElement);
            for (let step = 0; step <= focusableCount; step++) {
              await page.keyboard.press(tabKey);
              if (await isFocused()) break;
            }
            expect(await isFocused(), "native Tab reaches the Stage menu").toBe(
              true,
            );
            const failures: string[] = [];
            // The menu's items draw an inset ring (box-shadow) so the panel's
            // scrollport never clips it; the button keeps its outline.
            const check = async (
              label: string,
              target: Locator,
              ring: "outline" | "inset",
            ) => {
              const geometry = await controlGeometry(target);
              receipts.push({
                checkpoint: "phone-navigation-native-focus",
                observation: { browserName, rootPx, theme, label, geometry },
              });
              await shot(info, page, `nav-${label}-${theme}-root${rootPx}`);
              const indicator = geometry.focusIndicator;
              const drawn =
                ring === "outline"
                  ? indicator.state === "outline" &&
                    indicator.full &&
                    indicator.visibleArea.state === "positive"
                  : (
                      await target.evaluate(
                        (el) => getComputedStyle(el).boxShadow,
                      )
                    ).includes("inset");
              if (!drawn || !geometry.measured[0]?.full) failures.push(label);
            };
            await check("Stage menu", stageMenu, "outline");
            await page.keyboard.press("Enter");
            const items = page.getByRole("menuitem");
            const count = await items.count();
            expect(count).toBeGreaterThan(0);
            for (let index = 0; index < count; index++) {
              const item = items.nth(index);
              await expect(item).toBeFocused();
              await check((await item.innerText()).replaceAll("\n", " "), item);
              if (index < count - 1) await page.keyboard.press("ArrowDown");
            }
            expect(failures).toEqual([]);
            return;
          }
          const buttons = await navigation.getByRole("tab").all();
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
          const activeIndex = () =>
            navigation
              .getByRole("tab")
              .evaluateAll((elements) =>
                elements.findIndex(
                  (element) => element === document.activeElement,
                ),
              );
          for (let step = 0; step <= focusableCount; step++) {
            await page.keyboard.press(tabKey);
            if ((await activeIndex()) >= 0) break;
          }
          expect(
            await activeIndex(),
            "native Tab reaches the Stage bar",
          ).toBeGreaterThanOrEqual(0);
          await page.keyboard.press("Home");
          await expect.poll(activeIndex).toBe(0);

          const seen = new Set<number>();
          for (let index = 0; index < buttons.length; index++) {
            await expect.poll(activeIndex).toBe(index);
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
            if (index < buttons.length - 1)
              await page.keyboard.press("ArrowRight");
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
