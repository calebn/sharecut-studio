import { expect, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { controlGeometry } from "../e2e/inspectorResponsiveEvidence";
import {
  openPhoneTimeline,
  rememberInspectorDetent,
} from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { setTheme } from "../e2e/theme";
import {
  buildFixture,
  json,
  lane,
  setZoom,
  watchCommands,
} from "../e2e/touchTimeline";

const label =
  "Guest recording of the community workshop, including the opening questions, the discussion of shared equipment and access, the final participant reflections, the planning conversation for the next event, and the closing announcements for volunteers and visitors";

test.use({ hasTouch: true, reducedMotion: "reduce" });
for (const theme of ["light", "dark"] as const) {
  for (const transition of ["Close"] as const) {
    test.describe(`feedback host ${transition} ${theme}`, () => {
      test("clipped removal feedback keeps remaining lifetime after closing the compact host", async ({
        page,
      }, info) => {
        await withShareableProject(async (projectPath) => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.addInitScript(
            (value) => localStorage.setItem("daw_theme", value),
            theme,
          );
          await rememberInspectorDetent(page, "full");
          await openHostShare(page, projectPath);
          await buildFixture(page, projectPath, "e2e-feedback-host-lifetime");
          await postDocumentCommand(
            page,
            "e2e-feedback-host-label",
            "SetTrackMeta",
            { track_id: "guest", label },
            projectPath,
          );
          await setTheme(page, theme);
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          const details = page.getByRole("button", {
            name: `Open track details, ${label}`,
            exact: true,
          });
          await details.focus();
          await details.press("Enter");
          await page
            .locator(".modifier-inspector")
            .getByRole("button", { name: "Remove track", exact: true })
            .click();
          const commands = watchCommands(page);
          await page
            .getByRole("dialog")
            .getByRole("button", { name: "Remove track", exact: true })
            .click();
          const card = page.locator(".ui-toast-region--app .ui-toast");
          await expect(card).toContainText(`Removed ${label}`);
          await card.evaluate((element) => {
            element.setAttribute("data-lifetime-card", "same-card");
          });
          const dismiss = card.getByRole("button", {
            name: "Dismiss",
            exact: true,
          });
          await dismiss.focus();
          await page.setViewportSize({ width: 667, height: 360 });
          await openPhoneTimeline(page);
          await setZoom(page, 3);
          const point = page.locator(`${lane} [data-hit-id="env-c"]`);
          await point.focus();
          await point.press("Enter");
          await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
          await page.locator("html").evaluate((html) => {
            html.style.fontSize = "32px";
          });
          await expect(card).toHaveAttribute("data-lifetime-card", "same-card");
          await expect(
            card.getByRole("button", { name: "Undo", exact: true }),
          ).toBeEnabled();
          const close = page
            .locator(".bottom-sheet-header")
            .getByRole("button", { name: "Close", exact: true });
          const header = await controlGeometry(close);
          expect(header.fullyVisible).toBe(true);
          expect(header.hitsControl).toBe(true);
          const compact = await controlGeometry(card);
          json(info, "compact-long-removal-card", compact);
          expect(compact.fullyVisible).toBe(false);
          await close.focus();
          await close.click();
          await expect(
            page.locator(".ui-toast-region--inspector-flow"),
          ).toHaveCount(0);
          await expect(card).toHaveAttribute("data-lifetime-card", "same-card");
          await page.mouse.move(0, 0);
          const floating = await controlGeometry(card);
          expect(floating.fullyVisible).toBe(false);
          expect(
            await card.evaluate((element) => ({
              focus: element.contains(document.activeElement),
              hover: element.matches(":hover"),
            })),
          ).toEqual({ focus: false, hover: false });
          json(info, "floating-long-removal-card", { floating, commands });
          await info.attach("floating-clipped", {
            body: await page.screenshot({
              path: info.outputPath("floating-clipped.png"),
            }),
            contentType: "image/png",
          });
          await page.waitForTimeout(9000);
          await expect(card).toHaveAttribute("data-lifetime-card", "same-card");
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.locator("html").evaluate((html) => {
            html.style.fontSize = "16px";
          });
          await expect
            .poll(async () => (await controlGeometry(card)).fullyVisible)
            .toBe(true);
          await card.getByRole("button", { name: "Undo", exact: true }).click();
          await expect
            .poll(async () => {
              const res = await page.request.get(
                `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
              );
              const project = (await res.json()) as {
                tracks: { id: string }[];
              };
              return project.tracks.map((track) => track.id);
            })
            .toEqual(["reference", "guest"]);
          expect(commands.map((command) => command.type)).toEqual([
            "RemoveTrack",
            "UndoHistory",
          ]);
        });
      });
    });
  }
}
