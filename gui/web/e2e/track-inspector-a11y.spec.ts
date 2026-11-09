import { expect, type Request, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import {
  emptyEnvelopeProject,
  envelopeTrack,
} from "./envelopeCreationEvidence";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setTheme, withAppearance } from "./theme";
import { trackHeaderButton, trackHeaderButtons } from "./trackHeader";

const SHELLS = [
  { shell: "phone", viewport: { width: 360, height: 800 } },
  { shell: "desktop", viewport: { width: 1440, height: 900 } },
] as const;

for (const { shell, viewport } of SHELLS) {
  for (const { cell: rootFont, theme, reducedMotion } of withAppearance([
    16, 32,
  ] as const)) {
    test.describe(`Track Inspector ${shell} root${rootFont} ${theme}`, () => {
      test.use({
        viewport,
        reducedMotion: reducedMotion ? "reduce" : "no-preference",
      });

      test(`edits the track's name, kind and person and passes whole-sheet axe at root${rootFont}`, async ({
        page,
      }) => {
        await withShareableProject(
          async (projectPath) => {
            const track = envelopeTrack(projectPath);
            const metaWrites: string[] = [];
            const reorderWrites: string[] = [];
            page.on("request", (request: Request) => {
              if (
                request.method() === "POST" &&
                (request.postData() ?? "").includes("SetTrackMeta")
              )
                metaWrites.push(request.postData() ?? "");
              if (
                request.method() === "POST" &&
                (request.postData() ?? "").includes("ReorderTrack")
              )
                reorderWrites.push(request.postData() ?? "");
            });
            if (shell === "phone") await rememberInspectorDetent(page, "full");
            await openHostShare(page, projectPath);
            await openPhoneTimeline(page);
            await setTheme(page, theme);
            await page.locator("html").evaluate((html, px) => {
              html.style.fontSize = `${px}px`;
            }, rootFont);

            const header = trackHeaderButton(page, track.label);
            await expect(header).toBeVisible();
            await header.click();

            const dialog = page.getByRole("dialog", {
              name: "Inspector",
              exact: true,
            });
            await expect(dialog).toBeVisible();
            await expect(page.locator(".sys-inspector")).toHaveCount(1);
            if (shell === "phone") {
              await expect(dialog).toHaveClass(/\bsys-inspector--phone\b/);
              await expect(dialog).toHaveAttribute("data-detent", "full");
            }

            const name = dialog
              .locator(".sys-inspector-header")
              .getByRole("textbox", { name: "Name", exact: true });
            await expect(name).toHaveValue(track.label);
            await expect(
              dialog.locator(".sys-inspector-header .sys-person-avatar"),
            ).toBeVisible();

            const kind = dialog.getByRole("group", {
              name: "Kind",
              exact: true,
            });
            await kind.scrollIntoViewIfNeeded();
            await expect(
              kind.getByRole("button", { name: "Voice", exact: true }),
            ).toHaveAttribute("aria-pressed", "true");
            for (const label of ["Speaker", "Role"])
              await expect(
                dialog.getByLabel(label, { exact: true }),
              ).toHaveCount(0);

            const people = dialog.getByRole("radiogroup", {
              name: "Who is this voice?",
              exact: true,
            });
            await people.scrollIntoViewIfNeeded();
            const current = people.getByRole("radio", { name: /reference/ });
            await expect(current).toHaveAttribute("aria-checked", "true");
            await expect(current).toBeFocused();
            const laneOrder = () => trackHeaderButtons(page).allTextContents();
            const lanesBefore = await laneOrder();
            await page.keyboard.press("ArrowDown");
            await expect(
              people.getByRole("radio", { name: /guest/ }),
            ).toBeFocused();
            await page.keyboard.press("ArrowUp");
            await expect(current).toBeFocused();
            await page.keyboard.press("ArrowDown");
            expect(await laneOrder()).toEqual(lanesBefore);
            expect(reorderWrites).toEqual([]);
            await expect(current).toHaveAttribute("aria-checked", "true");
            expect(metaWrites).toEqual([]);
            await expectPageAxeClean(page, ".sys-inspector");

            await name.fill("Narrator");
            await name.press("Enter");
            await expect(trackHeaderButton(page, "Narrator")).toBeVisible();
            await expect(name).toHaveValue("Narrator");

            await dialog.getByRole("button", { name: "Add person" }).click();
            const field = dialog.getByRole("textbox", {
              name: "Name of the new person",
            });
            await field.fill("Priya");
            await field.press("Enter");
            const priya = people.getByRole("radio", { name: /Priya/ });
            await expect(priya).toHaveAttribute("aria-checked", "true");
            await expectPageAxeClean(page, ".sys-inspector");

            await page.keyboard.press("ControlOrMeta+z");
            await expect(priya).toHaveCount(0);
            await expect(
              people.getByRole("radio", { name: /reference/ }),
            ).toHaveAttribute("aria-checked", "true");
            await expect(trackHeaderButton(page, "Narrator")).toBeVisible();
          },
          undefined,
          emptyEnvelopeProject,
        );
      });
    });
  }
}
