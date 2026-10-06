import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

const COMMENTER_BANNER =
  "Shared comment view · You can comment and suggest edits";

async function expectNoHorizontalScroll(guest: Page, width: number) {
  await expect
    .poll(() => guest.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

for (const theme of ["light", "dark"] as const) {
  test(`a Commenter link opens Sharecut Studio, comments and replies at 1440 in ${theme}`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          {
            viewport: { width: 1440, height: 900 },
            colorScheme: theme,
            reducedMotion: "reduce",
          },
        ],
        async ([host, guest]) => {
          await openHostShare(host, projectPath);
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);
          await expect(
            guest.getByText(COMMENTER_BANNER, { exact: true }),
          ).toBeVisible();

          await guest
            .getByRole("button", { name: "Comment", exact: true })
            .first()
            .click();
          await guest
            .getByRole("slider", { name: "Comment time anchor" })
            .click();
          const body = `Commenter feedback in ${theme}`;
          await guest
            .getByRole("textbox", { name: "Comment", exact: true })
            .fill(body);
          await guest
            .getByRole("button", { name: "Post comment", exact: true })
            .click();
          const comment = guest
            .locator(".comments-list > li")
            .filter({ hasText: body });
          await expect(comment).toBeVisible();
          await comment.getByPlaceholder("Reply…").fill("This is the reply.");
          await comment
            .getByRole("button", { name: "Reply", exact: true })
            .click();
          await expect(
            comment.getByText("This is the reply.", { exact: true }),
          ).toBeVisible();
          await expectNoHorizontalScroll(guest, 1440);
          await expectPageAxeClean(guest);
          await guest.screenshot({
            path: test.info().outputPath("commenter-studio.png"),
          });
        },
      );
    });
  });

  test(`a Commenter link opens the phone Studio with comments in reach at 320 in ${theme}`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          {
            viewport: { width: 320, height: 900 },
            colorScheme: theme,
            reducedMotion: "reduce",
          },
        ],
        async ([host, guest]) => {
          await openHostShare(host, projectPath);
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);
          await expect(
            guest.getByText(COMMENTER_BANNER, { exact: true }),
          ).toBeVisible();
          await guest
            .getByRole("navigation", { name: "Primary" })
            .getByRole("button", { name: "More", exact: true })
            .click();
          await guest
            .getByRole("button", { name: "Comments", exact: true })
            .first()
            .click();
          await expect(guest.getByText("Commenting as")).toContainText("Guest");
          await expect(
            guest.getByRole("button", { name: "Comment mode", exact: true }),
          ).toBeVisible();
          await expectNoHorizontalScroll(guest, 320);
          await expectPageAxeClean(guest);
          await guest.screenshot({
            path: test.info().outputPath("commenter-phone.png"),
          });
        },
      );
    });
  });
}
