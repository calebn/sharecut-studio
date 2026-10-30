import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { selectCommentCard } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

const COMMENTER_BANNER =
  "Shared comment view · You can comment and suggest edits";

async function expectNoHorizontalScroll(guest: Page, width: number) {
  await expect
    .poll(() => guest.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

for (const theme of ["light", "dark"] as const) {
  test(`a Commenter link opens ShareCut Studio, comments and replies at 1440 in ${theme}`, async ({
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

          const body = `Commenter feedback in ${theme}`;
          await guest
            .getByRole("textbox", { name: "Comment", exact: true })
            .fill(body);
          await guest
            .getByRole("button", { name: "Post", exact: true })
            .click();
          const comment = await selectCommentCard(guest, body);
          await comment
            .getByRole("textbox", { name: /^Reply/ })
            .fill("This is the reply.");
          await comment.getByRole("button", { name: /^Reply/ }).click();
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

  test(`a Commenter posts from the phone Listen view on first load at 320x568 in ${theme}`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          {
            viewport: { width: 320, height: 568 },
            colorScheme: theme,
            reducedMotion: "reduce",
            hasTouch: true,
          },
        ],
        async ([host, guest]) => {
          await openHostShare(host, projectPath);
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);
          await expect(
            guest.getByText(COMMENTER_BANNER, { exact: true }),
          ).toBeVisible();
          await expect(
            guest.getByRole("dialog", { name: "Inspector" }),
          ).toHaveCount(0);

          const dock = guest.locator(".rv-compose");
          const field = dock.getByRole("textbox", {
            name: "Comment",
            exact: true,
          });
          const post = dock.getByRole("button", { name: "Post", exact: true });
          await expect(field).toBeInViewport();
          await expect(post).toBeInViewport();
          await expect(post).toBeDisabled();
          await expect(dock.locator(".sys-composer-chip")).toContainText(
            "Follows the playhead",
          );

          const body = `Phone guest feedback in ${theme}`;
          await field.tap();
          await field.fill(body);
          await post.tap();
          await expect(field).toHaveValue("");
          const posted = await selectCommentCard(guest, body);
          await expect(posted).toContainText("0:00");
          await expect(
            guest.getByRole("dialog", { name: "Inspector" }),
          ).toHaveCount(0);
          await expectNoHorizontalScroll(guest, 320);
          await expectPageAxeClean(guest);
          await guest.screenshot({
            path: test.info().outputPath("commenter-phone-posted.png"),
          });

          await expect(
            dock.getByRole("textbox", { name: "Your name" }),
          ).toHaveValue("Guest");
          await expectNoHorizontalScroll(guest, 320);
        },
      );
    });
  });
}

test("a Viewer link shows no comment field on the phone", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [{}, { viewport: { width: 375, height: 667 }, reducedMotion: "reduce" }],
      async ([host, guest]) => {
        await openHostShare(host, projectPath);
        const token = await createReviewShare(host, projectPath, "viewer");
        await openGuestShare(guest, token);
        await expect(guest.getByRole("main", { name: "Review" })).toBeVisible();
        await expect(
          guest.getByRole("textbox", { name: "Comment", exact: true }),
        ).toHaveCount(0);
        await expect(guest.locator(".rv-compose")).toHaveCount(0);
      },
    );
  });
});
