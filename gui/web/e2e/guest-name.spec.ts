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
  const rows = host.locator('.sys-queue-row[data-kind="comment"]');
  await expect(rows).toHaveCount(count);
  // The author is on the card's heading, so open each row to read it.
  const texts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await rows.nth(i).getByRole("button").click();
    const heading = host.getByRole("heading", { level: 2 });
    await expect(heading).toContainText("Comment from");
    texts.push(`${await heading.innerText()} ${await rows.nth(i).innerText()}`);
  }
  return texts;
}

function composer(guest: Page): Locator {
  return guest.locator(".stage-host-guest-comments");
}

const POST = { name: "Post", exact: true } as const;

function fields(dock: Locator) {
  return {
    field: dock.getByRole("textbox", { name: "Comment", exact: true }),
    name: dock.getByRole("textbox", { name: "Your name" }),
    post: dock.getByRole("button", POST),
  };
}

async function reached(control: Locator): Promise<boolean> {
  return control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return hit !== null && el.contains(hit);
  });
}

async function withGuest(
  browser: import("@playwright/test").Browser,
  size: { width: number; height: number },
  run: (guest: Page, host: Page, dock: Locator) => Promise<void>,
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
        await run(guest, host, composer(guest));
      },
    );
  });
}

async function withNamedGuest(
  browser: import("@playwright/test").Browser,
  size: { width: number; height: number },
  who: string,
  run: (guest: Page, dock: Locator) => Promise<void>,
  colorScheme: "light" | "dark" = "light",
) {
  await withGuest(
    browser,
    size,
    async (guest, _host, dock) => {
      const { field, name, post } = fields(dock);
      await field.fill("First");
      await name.fill(who);
      await post.tap();
      await expect(dock.locator(".comment-author-line strong")).toHaveText(who);
      await run(guest, dock);
    },
    colorScheme,
  );
}

for (const theme of ["light", "dark"] as const) {
  for (const phone of PHONES) {
    test(`a phone guest names themselves with the first comment: ${phone.name} ${phone.width}x${phone.height} ${theme}`, async ({
      browser,
    }) => {
      await withGuest(
        browser,
        phone,
        async (guest, host, dock) => {
          const { field, name, post } = fields(dock);
          await field.tap();
          await field.fill("Loved the intro");
          await expect(name).toBeVisible();
          await expectInView(name);
          await expectInView(post);
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
          await expect(name).toHaveCount(0);
          await expect(dock.locator(".comment-author-line strong")).toHaveText(
            "Riley Okafor",
          );
          await expectTouchTarget(
            dock.getByRole("button", { name: "Change your comment name" }),
          );
          await expectNoHorizontalScroll(guest, phone.width);

          const rows = await hostComments(host, 1);
          expect(rows[0]).toContain("Riley Okafor");
          expect(rows[0]).not.toContain("Guest");

          await guest.reload();
          await expect(dock.locator(".comment-author-line strong")).toHaveText(
            "Riley Okafor",
          );
          await field.tap();
          await field.fill("Second note");
          await post.tap();
          await expect(name).toHaveCount(0);
          await expect(field).toHaveValue("");
        },
        theme,
      );
    });
  }
}

test("a phone guest can leave the name blank and change it later", async ({
  browser,
}) => {
  await withGuest(
    browser,
    { width: 390, height: 844 },
    async (_guest, host, dock) => {
      const { field, post } = fields(dock);
      await field.fill("Anonymous note");
      await post.tap();
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
      await post.tap();
      await expect(field).toHaveValue("");

      const rows = await hostComments(host, 2);
      expect(rows.join("\n")).toContain("Alex");
      expect(rows.join("\n")).toContain("Guest");
    },
  );
});

const DOCK_SIZES = [
  { width: 390, height: 340 },
  { width: 320, height: 300 },
  { width: 667, height: 375 },
  { width: 568, height: 320 },
  { width: 320, height: 568 },
] as const;

for (const size of DOCK_SIZES) {
  const label = `${size.width}x${size.height}`;

  test(`the name field and Post stay uncovered with the comment field focused, at ${label}`, async ({
    browser,
  }) => {
    await withGuest(browser, size, async (guest, _host, dock) => {
      const { field, name, post } = fields(dock);
      await field.focus();
      await field.fill("Keyboard note");
      for (const control of [name, post]) {
        await expectInView(control);
        expect(await reached(control)).toBe(true);
      }
      await expectNoHorizontalScroll(guest, size.width);
    });
  });

  test(`a named guest keeps Post whole and uncovered, field focused or not, at ${label}`, async ({
    browser,
  }) => {
    await withNamedGuest(browser, size, "Riley", async (guest, dock) => {
      const { field, post } = fields(dock);
      for (const focused of [false, true]) {
        if (focused) {
          await field.focus();
          await field.fill("Typing");
        } else if (size.height < 360) continue;
        await expectInView(post);
        await expect
          .poll(() => reached(post), { message: "covered" })
          .toBe(true);
      }
      await expectNoHorizontalScroll(guest, size.width);
    });
  });

  test(`a 40-character unbroken name stays inside the composer and its Change editor stays in its column, at ${label}`, async ({
    browser,
  }) => {
    await withNamedGuest(browser, size, "W".repeat(40), async (guest, dock) => {
      await expectNoHorizontalScroll(guest, size.width);
      expect(
        await dock.evaluate((el) => el.scrollWidth <= el.clientWidth),
        "composer scrolls sideways",
      ).toBe(true);
      const panel = await dock.boundingBox();
      const strong = await dock
        .locator(".comment-author-line strong")
        .boundingBox();
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
      }
      await expectNoHorizontalScroll(guest, size.width);
    });
  });
}

for (const size of [
  { width: 667, height: 375 },
  { width: 568, height: 320 },
]) {
  test(`a failed post shows its alert full width and Post stays reachable at ${size.width}x${size.height}`, async ({
    browser,
  }) => {
    await withNamedGuest(browser, size, "Riley", async (guest, dock) => {
      const { field, post } = fields(dock);
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
      await post.tap();
      const alert = dock.getByRole("alert");
      await expect(alert).toBeVisible();
      const alertBox = await alert.boundingBox();
      const dockBox = await dock.boundingBox();
      expect(alertBox).not.toBeNull();
      expect(dockBox).not.toBeNull();
      if (alertBox && dockBox) {
        expect(alertBox.width).toBeGreaterThan(dockBox.width * 0.75);
      }
      await post.scrollIntoViewIfNeeded();
      await expectInView(post);
      await expect(field).toHaveValue("Will fail");
    });
  });
}
