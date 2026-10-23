import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

const TOUCH_MIN = 44;

const PHONES = [
  { name: "portrait", width: 390, height: 844 },
  { name: "landscape", width: 844, height: 390 },
  { name: "narrow", width: 320, height: 568 },
  { name: "keyboard-open", width: 390, height: 340 },
] as const;

async function expectTouchTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
}

async function expectNoHorizontalScroll(page: Page, width: number) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

async function hostComments(host: Page, count: number): Promise<string[]> {
  await host.reload();
  await host
    .getByLabel("Editor panels")
    .getByRole("tab", { name: "Comments" })
    .click();
  const rows = host.locator(".comments-list > li");
  await expect(rows).toHaveCount(count);
  return rows.allInnerTexts();
}

function composer(guest: Page, landscape: boolean): Locator {
  return landscape
    ? guest.locator(".comments-panel")
    : guest.getByRole("region", { name: "Add a comment" });
}

for (const theme of ["light", "dark"] as const) {
  for (const phone of PHONES) {
    test(`a phone guest names themselves on the first comment: ${phone.name} ${phone.width}x${phone.height} ${theme}`, async ({
      browser,
    }) => {
      await withShareableProject(async (projectPath) => {
        await withBrowserPages(
          browser,
          [
            {},
            {
              viewport: { width: phone.width, height: phone.height },
              colorScheme: theme,
              reducedMotion: "reduce",
              hasTouch: true,
              isMobile: true,
            },
          ],
          async ([host, guest]) => {
            await openHostShare(host, projectPath);
            const token = await createReviewShare(
              host,
              projectPath,
              "commenter",
            );
            await openGuestShare(guest, token);

            const dock = composer(guest, phone.name === "landscape");
            const field = dock.getByRole("textbox", {
              name: "Comment",
              exact: true,
            });
            const post = dock.getByRole("button", { name: "Post comment" });
            await field.tap();
            await field.fill("Loved the intro");
            await post.tap();

            const name = dock.getByRole("textbox", { name: "Your name" });
            const skip = dock.getByRole("button", { name: "Post as Guest" });
            await expect(name).toBeVisible();
            await expect(name).toBeInViewport({ ratio: 1 });
            await expect(skip).toBeInViewport({ ratio: 1 });
            await expect(post).toBeInViewport({ ratio: 1 });
            await expect(field).toHaveValue("Loved the intro");
            await expect(host.locator(".comments-list > li")).toHaveCount(0);
            await expectTouchTarget(skip);
            await expectTouchTarget(post);
            expect(
              (await name.boundingBox())?.height ?? 0,
            ).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
            expect(
              await name.evaluate((el) => getComputedStyle(el).fontSize),
            ).toBe("16px");
            await expectNoHorizontalScroll(guest, phone.width);
            await expectPageAxeClean(guest);
            await guest.screenshot({
              path: test
                .info()
                .outputPath(
                  `name-prompt-${phone.name}-${phone.width}x${phone.height}-${theme}.png`,
                ),
            });

            await name.fill("Riley Okafor");
            await post.tap();
            await expect(field).toHaveValue("");
            const line = dock.locator(".comment-author-line strong");
            await expect(line).toHaveText("Riley Okafor");
            const change = dock.getByRole("button", {
              name: "Change your comment name",
            });
            await expectTouchTarget(change);
            await expectNoHorizontalScroll(guest, phone.width);
            await guest.screenshot({
              path: test
                .info()
                .outputPath(
                  `name-set-${phone.name}-${phone.width}x${phone.height}-${theme}.png`,
                ),
            });

            const rows = await hostComments(host, 1);
            expect(rows[0]).toContain("Riley Okafor");
            expect(rows[0]).not.toContain("Guest");

            await guest.reload();
            await expect(
              dock.locator(".comment-author-line strong"),
            ).toHaveText("Riley Okafor");
            await field.tap();
            await field.fill("Second note");
            await post.tap();
            await expect(
              dock.getByRole("textbox", { name: "Your name" }),
            ).toHaveCount(0);
            await expect(field).toHaveValue("");
          },
        );
      });
    });
  }
}

test("a phone guest can skip the name and change it later", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          viewport: { width: 390, height: 844 },
          reducedMotion: "reduce",
          hasTouch: true,
          isMobile: true,
        },
      ],
      async ([host, guest]) => {
        await openHostShare(host, projectPath);
        const token = await createReviewShare(host, projectPath, "commenter");
        await openGuestShare(guest, token);
        const dock = guest.getByRole("region", { name: "Add a comment" });
        const field = dock.getByRole("textbox", {
          name: "Comment",
          exact: true,
        });
        await field.fill("Anonymous note");
        await dock.getByRole("button", { name: "Post comment" }).tap();
        await dock.getByRole("button", { name: "Post as Guest" }).tap();
        await expect(field).toHaveValue("");
        await expect(dock.getByText("Guest", { exact: true })).toBeVisible();

        await dock
          .getByRole("button", { name: "Change your comment name" })
          .tap();
        const rename = dock.getByRole("textbox", { name: "Your name" });
        await rename.fill("Alex");
        await rename.press("Enter");
        await field.fill("Named note");
        await dock.getByRole("button", { name: "Post comment" }).tap();
        await expect(field).toHaveValue("");

        const rows = await hostComments(host, 2);
        expect(rows.join("\n")).toContain("Alex");
        expect(rows.join("\n")).toContain("Guest");
      },
    );
  });
});

test("a tablet guest who changes the name before the first comment is not asked again", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          viewport: { width: 844, height: 390 },
          reducedMotion: "reduce",
          hasTouch: true,
          isMobile: true,
        },
      ],
      async ([host, guest]) => {
        await openHostShare(host, projectPath);
        const token = await createReviewShare(host, projectPath, "commenter");
        await openGuestShare(guest, token);
        const panel = guest.locator(".comments-panel");
        await panel
          .getByRole("button", { name: "Change your comment name" })
          .tap();
        const rename = panel.getByRole("textbox", { name: "Your name" });
        await rename.fill("Alex");
        await rename.press("Enter");
        await panel
          .getByRole("textbox", { name: "Comment", exact: true })
          .fill("Named first");
        await panel.getByRole("button", { name: "Post comment" }).tap();
        await expect(
          panel.getByRole("textbox", { name: "Comment", exact: true }),
        ).toHaveValue("");
        await expect(
          panel.getByRole("button", { name: "Post as Guest" }),
        ).toHaveCount(0);
        const rows = await hostComments(host, 1);
        expect(rows[0]).toContain("Alex");
        expect(rows[0]).not.toContain("Guest");
      },
    );
  });
});

test("the name step's buttons stay uncovered while the comment field is focused with the keyboard up", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          viewport: { width: 390, height: 340 },
          reducedMotion: "reduce",
          hasTouch: true,
          isMobile: true,
        },
      ],
      async ([host, guest]) => {
        await openHostShare(host, projectPath);
        const token = await createReviewShare(host, projectPath, "commenter");
        await openGuestShare(guest, token);
        const dock = guest.getByRole("region", { name: "Add a comment" });
        const field = dock.getByRole("textbox", {
          name: "Comment",
          exact: true,
        });
        await field.fill("Keyboard note");
        await dock.getByRole("button", { name: "Post comment" }).tap();
        await expect(
          dock.getByRole("textbox", { name: "Your name" }),
        ).toBeVisible();
        await field.focus();
        await field.fill("Keyboard note, edited");
        for (const name of ["Post as Guest", "Post comment"]) {
          const button = dock.getByRole("button", { name });
          await expect(button).toBeInViewport({ ratio: 1 });
          const reached = await button.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return hit !== null && el.contains(hit);
          });
          expect(reached, `${name} is covered`).toBe(true);
        }
      },
    );
  });
});

for (const size of [
  { width: 390, height: 340 },
  { width: 320, height: 300 },
]) {
  test(`a named guest's Post comment stays whole above the tab bar with the keyboard up at ${size.width}x${size.height}`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          {
            viewport: size,
            reducedMotion: "reduce",
            hasTouch: true,
            isMobile: true,
          },
        ],
        async ([host, guest]) => {
          await openHostShare(host, projectPath);
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);
          const dock = guest.getByRole("region", { name: "Add a comment" });
          const field = dock.getByRole("textbox", {
            name: "Comment",
            exact: true,
          });
          await field.fill("First");
          await dock.getByRole("button", { name: "Post comment" }).tap();
          await dock.getByRole("textbox", { name: "Your name" }).fill("Riley");
          await dock.getByRole("button", { name: "Post comment" }).tap();
          await expect(dock.locator(".comment-author-line strong")).toHaveText(
            "Riley",
          );
          await field.focus();
          await field.fill("Second");
          const nav = guest.getByRole("navigation", { name: "Primary" });
          await expect(nav).toBeInViewport({ ratio: 1 });
          const post = dock.getByRole("button", { name: "Post comment" });
          await expect(post).toBeInViewport({ ratio: 1 });
          const reached = await post.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return hit !== null && el.contains(hit);
          });
          expect(reached, "Post comment is covered").toBe(true);
        },
      );
    });
  });
}

for (const size of [
  { width: 667, height: 375 },
  { width: 568, height: 320 },
]) {
  test(`a named guest not typing keeps the Listen view and the 35% dock it had before naming at ${size.width}x${size.height}`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          {
            viewport: size,
            reducedMotion: "reduce",
            hasTouch: true,
            isMobile: true,
          },
        ],
        async ([host, guest]) => {
          await openHostShare(host, projectPath);
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);
          const dock = guest.getByRole("region", { name: "Add a comment" });
          const field = dock.getByRole("textbox", {
            name: "Comment",
            exact: true,
          });
          const play = guest.getByRole("button", { name: "Play", exact: true });
          const view = () =>
            guest.evaluate(() => {
              const dockBox = document
                .querySelector(".mobile-dock")
                ?.getBoundingClientRect();
              const body = document
                .querySelector(".mobile-mode-body")
                ?.getBoundingClientRect();
              const playBox = Array.from(document.querySelectorAll("button"))
                .find((b) => b.textContent?.trim() === "Play")
                ?.getBoundingClientRect();
              return {
                dockHeight: dockBox?.height ?? 0,
                bodyHeight: body?.height ?? 0,
                playBottom: playBox?.bottom ?? 0,
                dockTop: dockBox?.top ?? 0,
              };
            });
          await expect(play).toBeVisible();
          const before = await view();
          await field.fill("First");
          await dock.getByRole("button", { name: "Post comment" }).tap();
          await dock.getByRole("textbox", { name: "Your name" }).fill("Riley");
          await dock.getByRole("button", { name: "Post comment" }).tap();
          await expect(dock.locator(".comment-author-line strong")).toHaveText(
            "Riley",
          );
          await expect(field).not.toBeFocused();
          await expect(async () => {
            const after = await view();
            expect(after.dockHeight).toBeLessThanOrEqual(size.height * 0.35);
            expect(after.bodyHeight).toBeGreaterThanOrEqual(
              before.bodyHeight - 1,
            );
            if (before.playBottom <= before.dockTop + 0.5) {
              expect(after.playBottom).toBeLessThanOrEqual(after.dockTop + 0.5);
            }
          }).toPass();
        },
      );
    });
  });
}
