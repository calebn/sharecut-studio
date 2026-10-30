import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { goToStage, selectCommentCard } from "./stageNav";
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
          ).toHaveValue("");
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

async function suggestCut(
  host: Page,
  projectPath: string,
  waive: boolean,
): Promise<void> {
  const query = `?path=${encodeURIComponent(projectPath)}`;
  const shell = await host.request.get(`/api/project${query}&phase=shell`);
  const { tracks } = (await shell.json()) as {
    tracks: { id: string; role?: string }[];
  };
  const track = tracks.find((t) => t.role === "dialogue") ?? tracks[0];
  const sent = await host.request.post(`/api/document/command${query}`, {
    data: {
      type: "SuggestPendingEdit",
      payload: {
        track_id: track.id,
        start: 0,
        end: 2,
        reason: "guest:suggest",
      },
      client_id: "e2e-editor-queue",
      role: "viewer",
      client_seq: Date.now(),
    },
  });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  if (waive)
    await host.request.post("/api/transcript/refine/waive", {
      data: { path: projectPath, reason: "e2e editor queue" },
    });
}

async function openSuggestions(host: Page, projectPath: string) {
  const res = await host.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const { pending_edits } = (await res.json()) as {
    pending_edits: { applied: boolean; review_required: boolean }[];
  };
  return pending_edits.filter((e) => !e.applied && e.review_required).length;
}

for (const waived of [true, false]) {
  test(`an Editor link gets the suggested cuts in Review and Cut ${waived ? "applies one" : "is refused while the transcript is unchecked"}, a Commenter link does not`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
          { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
        ],
        async ([host, editor, commenter]) => {
          await openHostShare(host, projectPath);
          await suggestCut(host, projectPath, waived);
          await openGuestShare(
            commenter,
            await createReviewShare(host, projectPath, "commenter"),
          );
          await expect(commenter.locator(".rv-queue")).toBeVisible();
          await expect(commenter.locator(".sys-queue-row")).toHaveCount(0);
          await expect(
            commenter.getByRole("button", { name: /^Cut/ }),
          ).toHaveCount(0);

          await openGuestShare(
            editor,
            await createReviewShare(host, projectPath, "editor"),
          );
          await goToStage(editor, "review");
          await expect(
            editor.locator('.sys-queue-row:not([data-kind="comment"])').first(),
          ).toBeVisible();
          const before = await openSuggestions(host, projectPath);
          expect(before).toBeGreaterThan(0);
          await editor.getByRole("button", { name: /^Cut/ }).first().click();
          if (waived) {
            await expect
              .poll(() => openSuggestions(host, projectPath))
              .toBe(before - 1);
          } else {
            await editor.locator(".guest-attention-head").click();
            await expect(
              editor.getByText(/blocked until transcript refinement/),
            ).toBeVisible();
            expect(await openSuggestions(host, projectPath)).toBe(before);
          }
          if (waived) await expectPageAxeClean(editor);
        },
      );
    });
  });
}
