import { expect, type Locator, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import {
  expectDialogLowerTargetReachable,
  expectMenuLastItemReachable,
  expectShareRecordRoomsReachable,
  expectVisibleInOverlay,
  openDialogFromMenu,
  openHostProject,
  SHORT_VIEWPORTS,
} from "./overlayReachability";

function expectTouchHeight(height: number, layoutHeight: number): void {
  expect(layoutHeight).toBeGreaterThanOrEqual(44);
  // Translated DOM rectangles can report 43.999996px for a 44px layout box.
  expect(height).toBeGreaterThanOrEqual(44 - 0.001);
}

test("reports scroll evaluator failures from overlay reachability", async ({
  page,
}) => {
  await page.setContent('<div id="overlay"><button>Target</button></div>');
  const overlay = page.locator("#overlay");
  const target = overlay.getByRole("button", { name: "Target" });
  const failureMessage = "intentional scroll evaluator failure";
  await target.evaluate((el, message) => {
    el.scrollIntoView = () => {
      throw new Error(message);
    };
  }, failureMessage);

  await expect(expectVisibleInOverlay(overlay, target)).rejects.toThrow(
    failureMessage,
  );
});

test.describe("overlay viewport scroll", () => {
  for (const viewport of SHORT_VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;

    test(`Menu last item is reachable at ${label}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openHostProject(page);
      await expectMenuLastItemReachable(page);
    });

    test(`Share dialog Record rooms is reachable at ${label}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openHostProject(page);
      await openDialogFromMenu(page, "Share…");
      const share = page.getByRole("dialog", { name: "Share", exact: true });
      const targets = await share
        .locator(".ui-control, .share-dialog-check")
        .evaluateAll((elements) =>
          elements.map((element) => ({
            height: element.getBoundingClientRect().height,
            layoutHeight:
              element instanceof HTMLElement ? element.offsetHeight : 0,
          })),
        );
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expectTouchHeight(target.height, target.layoutHeight);
      }
      await share.getByRole("button", { name: "Close", exact: true }).click();
      await expectShareRecordRoomsReachable(page);
    });
  }
});

interface DialogCase {
  /** Accessible dialog name (Dialog title). */
  name: string;
  /** Transport menu item that opens the dialog. */
  menuItem: string;
  /** Lowest action/content target; asserted reachable, never clicked. */
  targetName: string;
}

const DIALOG_CASES: DialogCase[] = [
  {
    name: "Bounce…",
    menuItem: "Bounce…",
    targetName: "Bounce",
  },
  {
    name: "Help",
    menuItem: "Export diagnostics…",
    targetName: "Create diagnostics bundle",
  },
  {
    name: "Commands and shortcuts",
    menuItem: "Commands and shortcuts",
    targetName: "Commands without keys",
  },
];

test.describe("dialog consumers reachability", () => {
  for (const viewport of SHORT_VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;
    for (const dialogCase of DIALOG_CASES) {
      test(`${dialogCase.name} dialog lower target is reachable at ${label}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await openHostProject(page);
        await openDialogFromMenu(page, dialogCase.menuItem);
        // The shortcuts cheatsheet has no trailing dialog action; target its
        // final command row rather than the final section heading.
        const targetFor =
          dialogCase.name === "Commands and shortcuts"
            ? (dialog: Locator) =>
                dialog
                  .locator(".command-palette-section")
                  .last()
                  .locator(".command-palette-run")
                  .last()
            : (dialog: Locator) =>
                dialog.getByRole("button", {
                  name: dialogCase.targetName,
                  exact: true,
                });
        if (dialogCase.name === "Bounce…") {
          const dialog = page.getByRole("dialog", { name: "Bounce…" });
          const labels = await dialog.locator("label").evaluateAll((rows) =>
            rows.map((row) => ({
              height: row.getBoundingClientRect().height,
              layoutHeight: row instanceof HTMLElement ? row.offsetHeight : 0,
              controlLeft: row.querySelector("input")?.getBoundingClientRect()
                .left,
              textLeft: row.querySelector("span")?.getBoundingClientRect().left,
            })),
          );
          expect(labels).toHaveLength(5);
          for (const row of labels) {
            expectTouchHeight(row.height, row.layoutHeight);
            expect(row.controlLeft).toBe(labels[0].controlLeft);
            expect(row.textLeft).toBe(labels[0].textLeft);
          }
          await expectPageAxeClean(page, ".ui-dialog-root");
        }
        await expectDialogLowerTargetReachable(
          page,
          dialogCase.name,
          targetFor,
        );
      });
    }
  }
});
