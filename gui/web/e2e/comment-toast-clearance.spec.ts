import { expect, type Page, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withAppearance } from "./theme";
import { withBrowserPages } from "./twoBrowserPages";

const PHONES = [
  { name: "portrait", width: 390, height: 844 },
  { name: "landscape", width: 844, height: 390 },
  { name: "small", width: 360, height: 640 },
  { name: "keyboard-open", width: 390, height: 340 },
] as const;

const COMPOSER =
  ".comment-compose, .comment-author-line, .comment-author-edit, .comment-name-step";

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const toast = document.querySelector(".ui-toast-region--app .ui-toast");
    if (!toast) return ["no toast"];
    const t = toast.getBoundingClientRect();
    const hits: string[] = [];
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      let { top, bottom } = r;
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (getComputedStyle(a).overflowY === "visible") continue;
        const box = a.getBoundingClientRect();
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
      const w = Math.min(t.right, r.right) - Math.max(t.left, r.left);
      const h = Math.min(t.bottom, bottom) - Math.max(t.top, top);
      if (w > 1 && h > 1) {
        hits.push(
          `${el.className} ${JSON.stringify({ left: r.left, top, right: r.right, bottom })}`,
        );
      }
    }
    return hits;
  }, COMPOSER);
}

for (const { cell: phone, theme } of withAppearance(PHONES)) {
  test(`the posted toast stays off the comment field and name step: ${phone.name} ${phone.width}x${phone.height} ${theme}`, async ({
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
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);

          const dock = guest.locator(".stage-host-guest-comments");
          const field = dock.getByRole("textbox", {
            name: "Comment",
            exact: true,
          });
          const toast = guest.locator(".ui-toast-region--app .ui-toast");
          const shot = (label: string) =>
            guest.screenshot({
              path: test
                .info()
                .outputPath(
                  `toast-${label}-${phone.name}-${phone.width}x${phone.height}-${theme}.png`,
                ),
            });

          await field.tap();
          await field.fill("Loved the intro");
          await dock.getByRole("textbox", { name: "Your name" }).fill("Riley");
          await dock.getByRole("button", { name: "Post", exact: true }).tap();

          await expect(toast).toContainText("Comment posted at");
          await expect(toast).toBeInViewport({ ratio: 1 });
          await settle(guest);
          await shot("posted");
          expect(await overlaps(guest)).toEqual([]);

          await field.tap();
          await expect(field).toBeFocused();
          await expect(toast).toBeVisible();
          await settle(guest);
          await shot("posted-focused");
          expect(await overlaps(guest)).toEqual([]);

          await dock
            .getByRole("button", { name: "Change your comment name" })
            .tap();
          await expect(
            dock.getByRole("textbox", { name: "Your name" }),
          ).toBeVisible();
          await expect(toast).toBeVisible();
          await settle(guest);
          await shot("changing-name");
          expect(await overlaps(guest)).toEqual([]);
        },
      );
    });
  });
}
