import { type Locator, type Page, test } from "@playwright/test";
import {
  expectDialogLowerTargetReachable,
  expectMenuLastItemReachable,
  expectShareRecordRoomsReachable,
  openHostProject,
  openTransportMenu,
  SHORT_VIEWPORTS,
} from "./overlayReachability";

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
    menuItem: "Help…",
    targetName: "Create diagnostics bundle",
  },
  {
    name: "Keyboard shortcuts",
    menuItem: "Keyboard shortcuts (?)",
    targetName: "Commands without keys",
  },
];

async function openDialogFromMenu(page: Page, menuItem: string): Promise<void> {
  await openTransportMenu(page);
  await page.getByRole("menuitem", { name: menuItem }).click();
}

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
        await expectDialogLowerTargetReachable(
          page,
          dialogCase.name,
          targetFor,
        );
      });
    }
  }
});
