import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import {
  expectDialogPresentation,
  openDialogFromMenu,
  openHostProject,
} from "./overlayReachability";

type Shell = { name: string; width: number; height: number; sheet: boolean };

const SHELLS: readonly Shell[] = [
  { name: "phone", width: 390, height: 844, sheet: true },
  { name: "phone landscape", width: 667, height: 375, sheet: true },
  { name: "tablet portrait", width: 820, height: 1180, sheet: true },
  { name: "tablet landscape", width: 1180, height: 820, sheet: true },
  { name: "desktop", width: 1440, height: 900, sheet: false },
];

/** Dialogs that were centered cards on a phone, and the primary each pins. */
const DIALOGS = [
  { item: "Bounce…", name: "Bounce…", primary: "Bounce" },
  { item: "Connect agent…", name: "Connect agent", primary: "Copy URL" },
] as const;

for (const shell of SHELLS) {
  test.describe(`dialogs as sheets: ${shell.name}`, () => {
    test.use({ viewport: { width: shell.width, height: shell.height } });

    for (const spec of DIALOGS) {
      test(`${spec.name} ${shell.sheet ? "rises as a sheet with its primary pinned" : "stays a centered card"}`, async ({
        page,
      }) => {
        await openHostProject(page);
        await openDialogFromMenu(page, spec.item);
        const { dialog, footer } = await expectDialogPresentation(
          page,
          spec.name,
          { sheet: shell.sheet, fullWidth: shell.name.startsWith("phone") },
        );
        if (spec.primary) {
          const primary = footer.getByRole("button", {
            name: spec.primary,
            exact: true,
          });
          await expect(primary).toBeVisible();
          const box = await primary.boundingBox();
          const vp = page.viewportSize();
          expect(box && vp && box.y + box.height <= vp.height).toBe(true);
        }
        await expectPageAxeClean(page, ".command-palette-panel");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      });
    }
  });
}
