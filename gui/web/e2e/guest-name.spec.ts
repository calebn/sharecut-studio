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

const DOCK_SIZES = [
  { width: 390, height: 340 },
  { width: 320, height: 300 },
  { width: 667, height: 375 },
  { width: 568, height: 320 },
  { width: 320, height: 568 },
] as const;

async function withNamedGuest(
  browser: import("@playwright/test").Browser,
  size: { width: number; height: number },
  name: string,
  run: (guest: Page, dock: Locator, field: Locator) => Promise<void>,
  colorScheme: "light" | "dark" = "light",
) {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          viewport: size,
          colorScheme,
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
        await dock.getByRole("textbox", { name: "Your name" }).fill(name);
        await dock.getByRole("button", { name: "Post comment" }).tap();
        await expect(dock.locator(".comment-author-line strong")).toHaveText(
          name,
        );
        await run(guest, dock, field);
      },
    );
  });
}

async function tapCentre(guest: Page, control: Locator) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await guest.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

for (const size of DOCK_SIZES) {
  const label = `${size.width}x${size.height}`;

  test(`one tap on Change opens the rename field and one tap on Post comment posts, at ${label}`, async ({
    browser,
  }) => {
    await withNamedGuest(browser, size, "Riley", async (guest, dock, field) => {
      await tapCentre(
        guest,
        dock.getByRole("button", { name: "Change your comment name" }),
      );
      const rename = dock.getByRole("textbox", { name: "Your name" });
      await expect(rename).toBeVisible();
      await rename.press("Escape");
      await expect(rename).toHaveCount(0);

      await field.focus();
      await field.fill("Second");
      await tapCentre(
        guest,
        dock.getByRole("button", { name: "Post comment" }),
      );
      await expect(field).toHaveValue("");
    });
  });

  test(`a 40-character unbroken name stays inside the dock and its Change editor stays in its column, at ${label}`, async ({
    browser,
  }) => {
    const longName = "W".repeat(40);
    await withNamedGuest(browser, size, longName, async (guest, dock) => {
      await expectNoHorizontalScroll(guest, size.width);
      const scrolls = await guest
        .locator(".mobile-dock")
        .evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(scrolls, "dock scrolls sideways").toBe(true);
      const strong = await dock
        .locator(".comment-author-line strong")
        .boundingBox();
      const compose = await dock.locator(".comment-compose").boundingBox();
      expect(strong).not.toBeNull();
      expect(compose).not.toBeNull();
      if (strong && compose && size.width >= 480 && size.height < 384) {
        expect(strong.x + strong.width).toBeLessThanOrEqual(compose.x + 0.5);
      }
      await dock
        .getByRole("button", { name: "Change your comment name" })
        .tap();
      const edit = await dock.locator(".comment-author-edit").boundingBox();
      const input = await dock
        .getByRole("textbox", { name: "Your name" })
        .boundingBox();
      expect(edit).not.toBeNull();
      expect(input).not.toBeNull();
      if (edit && input) {
        expect(input.x + input.width).toBeLessThanOrEqual(
          edit.x + edit.width + 0.5,
        );
        if (compose && size.width >= 480 && size.height < 384) {
          expect(input.x + input.width).toBeLessThanOrEqual(compose.x + 0.5);
        }
      }
      await expectNoHorizontalScroll(guest, size.width);
    });
  });
}

for (const size of [{ width: 390, height: 844 }, ...DOCK_SIZES]) {
  for (const focused of [false, true]) {
    // 390x340 and 320x300 stand in for a window with the keyboard up, which
    // only exists while a field is focused.
    if (!focused && size.height < 360) continue;
    test(`a named guest's dock keeps Post comment and the tab bar whole and uncovered, ${focused ? "field focused" : "not focused"}, at ${size.width}x${size.height}`, async ({
      browser,
    }) => {
      await withNamedGuest(
        browser,
        size,
        "Riley",
        async (guest, dock, field) => {
          if (focused) {
            await field.focus();
            await field.fill("Typing");
          }
          const nav = guest.getByRole("navigation", { name: "Primary" });
          await expect(nav).toBeInViewport({ ratio: 1 });
          for (const control of [
            dock.getByRole("button", { name: "Post comment" }),
            dock.getByRole("button", { name: "Change your comment name" }),
          ]) {
            if (focused && (await control.innerText()) === "Change") continue;
            await expect(control).toBeInViewport({ ratio: 1 });
            const reached = await control.evaluate((el) => {
              const r = el.getBoundingClientRect();
              const hit = document.elementFromPoint(
                r.left + r.width / 2,
                r.top + r.height / 2,
              );
              return hit !== null && el.contains(hit);
            });
            expect(reached, "covered").toBe(true);
          }
          await expectNoHorizontalScroll(guest, size.width);
          await guest.screenshot({
            path: test
              .info()
              .outputPath(
                `named-${focused ? "focused" : "unfocused"}-${size.width}x${size.height}.png`,
              ),
          });
        },
      );
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const size of [
    { width: 667, height: 375 },
    { width: 568, height: 320 },
  ]) {
    test(`a named guest in a short landscape window, not focused: ${size.width}x${size.height} ${theme}`, async ({
      browser,
    }) => {
      await withNamedGuest(
        browser,
        size,
        "Riley Okafor",
        async (guest, dock) => {
          await expect(
            dock.getByRole("button", { name: "Change your comment name" }),
          ).toBeInViewport({ ratio: 1 });
          await expectPageAxeClean(guest);
          await guest.screenshot({
            path: test
              .info()
              .outputPath(
                `named-landscape-${size.width}x${size.height}-${theme}.png`,
              ),
          });
        },
        theme,
      );
    });
  }
}

for (const size of [
  { width: 667, height: 375 },
  { width: 568, height: 320 },
]) {
  test(`a failed post shows its alert full width in the named dock and Post stays reachable at ${size.width}x${size.height}`, async ({
    browser,
  }) => {
    await withNamedGuest(browser, size, "Riley", async (guest, dock, field) => {
      await guest.route(/\/comments(\?|$)/, (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                detail: "The server could not save this comment right now.",
              }),
            })
          : route.continue(),
      );
      await field.fill("Will fail");
      await dock.getByRole("button", { name: "Post comment" }).tap();
      const alert = dock.getByRole("alert");
      await expect(alert).toBeVisible();
      const alertBox = await alert.boundingBox();
      const dockBox = await guest.locator(".mobile-dock").boundingBox();
      expect(alertBox).not.toBeNull();
      expect(dockBox).not.toBeNull();
      if (alertBox && dockBox) {
        expect(alertBox.width).toBeGreaterThan(dockBox.width * 0.75);
        // the failed post refocuses the field, so the keyboard relief applies
        expect(dockBox.height).toBeLessThanOrEqual(size.height * 0.6 + 1);
      }
      const post = dock.getByRole("button", { name: "Post comment" });
      await post.scrollIntoViewIfNeeded();
      await expect(post).toBeInViewport({ ratio: 1 });
      await expect(field).toHaveValue("Will fail");
    });
  });
}

for (const size of [
  { width: 320, height: 300 },
  { width: 390, height: 340 },
]) {
  const label = `${size.width}x${size.height}`;
  const longName = "W".repeat(40);

  test(`one tap on Post comment lands while the rename field is focused with a long name, at ${label}`, async ({
    browser,
  }) => {
    await withNamedGuest(
      browser,
      size,
      longName,
      async (guest, dock, field) => {
        await field.fill("From rename state");
        await tapCentre(
          guest,
          dock.getByRole("button", { name: "Change your comment name" }),
        );
        const rename = dock.getByRole("textbox", { name: "Your name" });
        await expect(rename).toBeFocused();
        expect(
          (await rename.boundingBox())?.height ?? 0,
        ).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
        await rename.fill("Kit");
        await tapCentre(
          guest,
          dock.getByRole("button", { name: "Post comment" }),
        );
        await expect(field).toHaveValue("");
        await expect(dock.locator(".comment-author-line strong")).toHaveText(
          "Kit",
        );
      },
    );
  });

  test(`one tap on Post comment lands in the name step with a long name, at ${label}`, async ({
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
          await field.fill("Long name note");
          await dock.getByRole("button", { name: "Post comment" }).tap();
          await dock.getByRole("textbox", { name: "Your name" }).fill(longName);
          await tapCentre(
            guest,
            dock.getByRole("button", { name: "Post comment" }),
          );
          await expect(field).toHaveValue("");
          await expect(dock.locator(".comment-author-line strong")).toHaveText(
            longName,
          );
        },
      );
    });
  });
}

for (const size of [
  { width: 667, height: 375 },
  { width: 568, height: 320 },
  { width: 320, height: 568 },
]) {
  test(`the Commenting as line has no separator dot and Change is its own element at ${size.width}x${size.height}`, async ({
    browser,
  }) => {
    await withNamedGuest(
      browser,
      size,
      size.width < 400 ? "W".repeat(40) : "Riley Okafor",
      async (_guest, dock) => {
        const line = dock.locator(".comment-author-line");
        expect(await line.evaluate((el) => el.textContent ?? "")).not.toContain(
          "·",
        );
        const change = dock.getByRole("button", {
          name: "Change your comment name",
        });
        expect(await change.evaluate((el) => el.parentElement?.tagName)).toBe(
          "P",
        );
      },
    );
  });
}
