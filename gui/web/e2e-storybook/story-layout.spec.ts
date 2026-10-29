import { devices, expect, type Locator, test } from "@playwright/test";
import { storyUrl } from "./storyUrl";

async function expectInside(element: Locator, bounds: "viewport" | "story") {
  await expect(element).toBeVisible();
  await expect
    .poll(() =>
      element.evaluate((el, target) => {
        const inner = el.getBoundingClientRect();
        const view = el.ownerDocument.defaultView;
        if (!view) throw new Error("Preview has no window");
        const host = target === "story" ? el.closest(".sb-story") : null;
        if (target === "story" && !host)
          throw new Error("Preview has no story host");
        const outer = host?.getBoundingClientRect() ?? {
          left: 0,
          top: 0,
          right: view.innerWidth,
          bottom: view.innerHeight,
        };
        return {
          left: Math.max(0, Math.ceil(outer.left - inner.left - 1)),
          top: Math.max(0, Math.ceil(outer.top - inner.top - 1)),
          right: Math.max(0, Math.ceil(inner.right - outer.right - 1)),
          bottom: Math.max(0, Math.ceil(inner.bottom - outer.bottom - 1)),
        };
      }, bounds),
    )
    .toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
}

for (const width of [1440, 360]) {
  for (const theme of ["light", "dark"] as const) {
    for (const story of ["default", "open", "with-shortcuts"]) {
      test(`Menu ${story} fits Canvas at ${width} in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 740 });
        await page.emulateMedia({
          colorScheme: theme === "light" ? "light" : "dark",
          reducedMotion: "reduce",
        });
        await page.goto(storyUrl(`molecules-menu--${story}`, { theme }));
        const trigger = page.getByRole("button", {
          name: story === "with-shortcuts" ? "Menu" : "Actions",
          exact: true,
        });
        await expect(trigger).toBeVisible();
        if (story === "default") await trigger.click();
        await expect(page.getByRole("menu")).toBeVisible();
        await expectInside(page.getByRole("menu"), "viewport");
      });
    }

    test(`Menu opened from its inline Docs host stays in the viewport at ${width} in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.emulateMedia({
        colorScheme: theme === "light" ? "light" : "dark",
        reducedMotion: "reduce",
      });
      await page.goto(
        storyUrl("molecules-menu--docs", { theme, viewMode: "docs" }),
      );
      const host = page.locator("#story--molecules-menu--default");
      await host.getByRole("button", { name: "Actions" }).click();
      await expectInside(host.getByRole("menu"), "viewport");
    });

    test(`Avatar overflow menu opened from its Docs host stays in the viewport at ${width} in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.emulateMedia({
        colorScheme: theme === "light" ? "light" : "dark",
        reducedMotion: "reduce",
      });
      await page.goto(
        storyUrl("templates-avatarstack--docs", { theme, viewMode: "docs" }),
      );
      const host = page.locator("#story--templates-avatarstack--overflow");
      await host.getByRole("button", { name: "+2 more" }).click();
      await expectInside(host.getByRole("menu"), "viewport");
    });

    test(`JoinPopover Docs contains every fixed panel at ${width} in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.emulateMedia({
        colorScheme: theme === "light" ? "light" : "dark",
        reducedMotion: "reduce",
      });
      await page.goto(
        storyUrl("templates-joinpopover--docs", { theme, viewMode: "docs" }),
      );
      const docs = page;
      for (const story of [
        "fade",
        "crossfade",
        "cut",
        "blocked-crossfade",
        "read-only",
        "busy-with-error",
      ]) {
        const iframe = docs.locator(
          `#story--templates-joinpopover--${story} iframe`,
        );
        await expect(iframe).toBeAttached();
        await iframe.scrollIntoViewIfNeeded();
        const frame = docs.frameLocator(
          `#story--templates-joinpopover--${story} iframe`,
        );
        await expectInside(frame.locator(".command-palette-panel"), "viewport");
        await expect(frame.locator("html")).toHaveCSS("color-scheme", theme);
      }
      await expect(docs.getByRole("dialog")).toHaveCount(0);
    });

    for (const [family, story] of [
      ["organisms-dialog", "default"],
      ["organisms-bottomsheet", "default"],
      ["templates-gesturessheet", "open"],
      ["templates-hostmcpdialog", "ready"],
      ["templates-commandpalette", "browse"],
    ]) {
      test(`${family} contains its portaled dialog in Docs at ${width} in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 740 });
        await page.emulateMedia({
          colorScheme: theme === "light" ? "light" : "dark",
          reducedMotion: "reduce",
        });
        await page.goto(
          storyUrl(`${family}--docs`, { theme, viewMode: "docs" }),
        );
        const docs = page;
        const selector = `#story--${family}--${story} iframe`;
        const iframe = docs.locator(selector);
        await expect(iframe).toBeAttached();
        await iframe.scrollIntoViewIfNeeded();
        const frame = docs.frameLocator(selector);
        await expectInside(
          frame.locator(".command-palette-panel, .bottom-sheet"),
          "viewport",
        );
        await expect(docs.getByRole("dialog")).toHaveCount(0);
      });
    }
  }
}

test("Menu rows are 44 px under a coarse pointer without the phone shell", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    baseURL: "http://127.0.0.1:6010",
  });
  const page = await context.newPage();
  await page.goto(storyUrl("molecules-menu--default", { theme: "light" }));
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  const rows = page.getByRole("menuitem");
  await expect(rows.first()).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.dataset.shell),
  ).not.toBe("phone");
  const heights = await rows.evaluateAll((items) =>
    items.map((row) => row.getBoundingClientRect().height),
  );
  await context.close();
  expect(heights.length).toBeGreaterThan(1);
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(43.5);
});
