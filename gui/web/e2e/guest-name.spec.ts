import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { openPanel, reloadProject } from "./stageNav";
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

/** The Review stage scrolls its panel, so bring the control up, then check it is whole. */
async function expectInView(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
}

async function expectNoHorizontalScroll(page: Page, width: number) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

async function hostComments(host: Page, count: number): Promise<string[]> {
  await reloadProject(host);
  await openPanel(host, "comments");
  const rows = host.locator(".comments-list > li");
  await expect(rows).toHaveCount(count);
  return rows.allInnerTexts();
}

function composer(guest: Page): Locator {
  return guest.locator(".comments-panel");
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

            const dock = composer(guest);
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
            await expectInView(name);
            await expectInView(skip);
            await expectInView(post);
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
        const dock = composer(guest);
        const field = dock.getByRole("textbox", {
          name: "Comment",
          exact: true,
        });
        await field.fill("Anonymous note");
        await dock.getByRole("button", { name: "Post comment" }).tap();
        await dock.getByRole("button", { name: "Post as Guest" }).tap();
        await expect(field).toHaveValue("");
        await expect(dock.locator(".comment-author-line strong")).toHaveText(
          "Guest",
        );

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
        const dock = composer(guest);
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
          await expectInView(button);
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
  test(`a named guest's Post comment stays whole with the keyboard up at ${size.width}x${size.height}`, async ({
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
          const dock = composer(guest);
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
          const post = dock.getByRole("button", { name: "Post comment" });
          await expectInView(post);
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
        const dock = composer(guest);
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

async function tapCentre(_guest: Page, control: Locator) {
  await control.tap();
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

  test(`a 40-character unbroken name stays inside the composer and its Change editor stays in its column, at ${label}`, async ({
    browser,
  }) => {
    const longName = "W".repeat(40);
    await withNamedGuest(browser, size, longName, async (guest, dock) => {
      await expectNoHorizontalScroll(guest, size.width);
      const scrolls = await dock.evaluate(
        (el) => el.scrollWidth <= el.clientWidth,
      );
      expect(scrolls, "composer scrolls sideways").toBe(true);
      const strong = await dock
        .locator(".comment-author-line strong")
        .boundingBox();
      const compose = await dock.locator(".comment-compose").boundingBox();
      expect(strong).not.toBeNull();
      expect(compose).not.toBeNull();
      const panel = await dock.boundingBox();
      if (strong && panel) {
        expect(strong.x + strong.width).toBeLessThanOrEqual(
          panel.x + panel.width + 0.5,
        );
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
        if (panel) {
          expect(input.x + input.width).toBeLessThanOrEqual(
            panel.x + panel.width + 0.5,
          );
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
    test(`a named guest's composer keeps Post comment whole and uncovered, ${focused ? "field focused" : "not focused"}, at ${size.width}x${size.height}`, async ({
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
          for (const control of [
            dock.getByRole("button", { name: "Post comment" }),
            dock.getByRole("button", { name: "Change your comment name" }),
          ]) {
            if (focused && (await control.innerText()) === "Change") continue;
            await expectInView(control);
            // The posted toast docks clear of the composer within a frame or two.
            await expect
              .poll(
                () =>
                  control.evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    const hit = document.elementFromPoint(
                      r.left + r.width / 2,
                      r.top + r.height / 2,
                    );
                    return hit !== null && el.contains(hit);
                  }),
                { message: "covered" },
              )
              .toBe(true);
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
          await expectInView(
            dock.getByRole("button", { name: "Change your comment name" }),
          );
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
  test(`a failed post shows its alert full width in the named composer and Post stays reachable at ${size.width}x${size.height}`, async ({
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
      const dockBox = await dock.boundingBox();
      expect(alertBox).not.toBeNull();
      expect(dockBox).not.toBeNull();
      if (alertBox && dockBox) {
        expect(alertBox.width).toBeGreaterThan(dockBox.width * 0.75);
      }
      const post = dock.getByRole("button", { name: "Post comment" });
      await post.scrollIntoViewIfNeeded();
      await expectInView(post);
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
          const dock = composer(guest);
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
