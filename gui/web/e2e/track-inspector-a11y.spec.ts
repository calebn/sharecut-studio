import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import {
  emptyEnvelopeProject,
  envelopeTrack,
} from "./envelopeCreationEvidence";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setTheme, withAppearance } from "./theme";
import { trackHeaderButton } from "./trackHeader";

for (const { cell: rootFont, theme, reducedMotion } of withAppearance([
  16, 32,
] as const)) {
  test.describe(`Track Inspector phone root${rootFont} ${theme}`, () => {
    test.use({
      viewport: { width: 360, height: 800 },
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });

    test(`shows Track metadata and passes whole-sheet axe at root${rootFont}`, async ({
      page,
    }) => {
      await withShareableProject(
        async (projectPath) => {
          const track = envelopeTrack(projectPath);
          await rememberInspectorDetent(page, "full");
          await openHostShare(page, projectPath);
          await openPhoneTimeline(page);
          await setTheme(page, theme);
          await page.locator("html").evaluate((html, px) => {
            html.style.fontSize = `${px}px`;
          }, rootFont);

          const appearance = await page.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            rootFont: getComputedStyle(document.documentElement).fontSize,
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)")
              .matches,
          }));
          expect(appearance).toEqual({
            theme,
            rootFont: `${rootFont}px`,
            reducedMotion,
          });

          const header = trackHeaderButton(page, track.label);
          await expect(header).toBeVisible();
          await header.click();

          const dialog = page.getByRole("dialog", {
            name: "Inspector",
            exact: true,
          });
          await expect(dialog).toBeVisible();
          await expect(dialog).toHaveClass(/\bsys-inspector--phone\b/);
          await expect(dialog).toHaveAttribute("data-detent", "full");
          await expect(page.locator(".sys-inspector")).toHaveCount(1);

          const body = dialog.locator(".sys-inspector-scroll");
          const name = dialog
            .locator(".sys-inspector-header")
            .getByRole("textbox", { name: "Name", exact: true });
          await expect(name).toHaveValue(track.label);

          const speaker = body.getByRole("textbox", {
            name: "Speaker",
            exact: true,
          });
          await speaker.scrollIntoViewIfNeeded();
          await expect(speaker).toBeVisible();

          const kind = body.getByRole("group", { name: "Kind", exact: true });
          await kind.scrollIntoViewIfNeeded();
          await expect(
            kind.getByRole("button", { name: "Voice", exact: true }),
          ).toHaveAttribute("aria-pressed", "true");

          for (const label of [`Mute ${track.label}`, `Solo ${track.label}`]) {
            const control = dialog.getByRole("button", {
              name: label,
              exact: true,
            });
            await control.scrollIntoViewIfNeeded();
            await expect(control).toBeVisible();
          }

          const level = dialog.getByRole("spinbutton", {
            name: "Level",
            exact: true,
          });
          await level.scrollIntoViewIfNeeded();
          await expect(level).toBeVisible();

          await expectPageAxeClean(page, ".sys-inspector");
        },
        undefined,
        emptyEnvelopeProject,
      );
    });
  });
}
