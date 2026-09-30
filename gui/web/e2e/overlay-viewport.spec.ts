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
    name: "Keyboard shortcuts",
    menuItem: "Keyboard shortcuts",
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
          dialogCase.name === "Keyboard shortcuts"
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
              controlLeft: row.querySelector("input")?.getBoundingClientRect()
                .left,
              textLeft: row.querySelector("span")?.getBoundingClientRect().left,
            })),
          );
          expect(labels).toHaveLength(5);
          for (const row of labels) {
            expect(row.height).toBeGreaterThanOrEqual(44);
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
