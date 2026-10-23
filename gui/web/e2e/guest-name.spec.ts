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

async function hostCommentAuthors(host: Page): Promise<string[]> {
  await host.reload();
  await host
    .getByLabel("Editor panels")
    .getByRole("tab", { name: "Comments" })
    .click();
  return host.locator(".comments-list > li").allInnerTexts();
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

            const dock = guest.getByRole("region", { name: "Add a comment" });
            const field = dock.getByRole("textbox", {
              name: "Comment",
              exact: true,
            });
            const post = dock.getByRole("button", { name: "Post comment" });
            await field.tap();
            await field.fill("Loved the intro");
            await post.tap();

            const name = dock.getByRole("textbox", { name: "Your name" });
            const skip = dock.getByRole("button", { name: "Skip" });
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
            const line = dock.getByText("Riley Okafor", { exact: true });
            await expect(line).toBeVisible();
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

            const rows = await hostCommentAuthors(host);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toContain("Riley Okafor");
            expect(rows[0]).not.toContain("Guest");

            await guest.reload();
            await expect(
              guest
                .getByRole("region", { name: "Add a comment" })
                .getByText("Riley Okafor", { exact: true }),
            ).toBeVisible();
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
        await dock.getByRole("button", { name: "Skip" }).tap();
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

        const rows = await hostCommentAuthors(host);
        expect(rows).toHaveLength(2);
        expect(rows.join("\n")).toContain("Alex");
        expect(rows.join("\n")).toContain("Guest");
      },
    );
  });
});
