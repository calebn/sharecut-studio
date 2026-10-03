import { expect, type Locator, test } from "@playwright/test";

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
  for (const theme of ["light", "dark"]) {
    for (const story of ["default", "open", "with-shortcuts"]) {
      test(`Menu ${story} fits Canvas at ${width} in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 740 });
        await page.emulateMedia({
          colorScheme: theme === "light" ? "light" : "dark",
          reducedMotion: "reduce",
        });
        await page.goto(
          `/iframe.html?id=molecules-menu--${story}&viewMode=story&globals=theme:${theme}`,
        );
        const trigger = page.getByRole("button", {
          name: story === "with-shortcuts" ? "Menu" : "Actions",
          exact: true,
        });
        await expect(trigger).toBeVisible();
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.click();
        }
        await expectInside(page.getByRole("menu"), "viewport");
      });
    }

    test(`Menu fits its inline Docs host at ${width} in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.emulateMedia({
        colorScheme: theme === "light" ? "light" : "dark",
        reducedMotion: "reduce",
      });
      await page.goto(
        `/iframe.html?id=molecules-menu--docs&viewMode=docs&globals=theme:${theme}`,
      );
      const host = page.locator("#story--molecules-menu--default");
      await host.getByRole("button", { name: "Actions" }).click();
      await expectInside(host.getByRole("menu"), "story");
    });

    test(`Avatar overflow fits its Docs host at ${width} in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.emulateMedia({
        colorScheme: theme === "light" ? "light" : "dark",
        reducedMotion: "reduce",
      });
      await page.goto(
        `/iframe.html?id=templates-avatarstack--docs&viewMode=docs&globals=theme:${theme}`,
      );
      const host = page.locator("#story--templates-avatarstack--overflow");
      await host.getByRole("button", { name: "+2 more" }).click();
      await expectInside(host.getByRole("menu"), "story");
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
        `/iframe.html?id=templates-joinpopover--docs&viewMode=docs&globals=theme:${theme}`,
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
        await expectInside(frame.locator(".join-popover"), "viewport");
        await expect(frame.locator("html")).toHaveCSS("color-scheme", theme);
      }
      await expect(docs.locator(".join-popover")).toHaveCount(0);
    });

    for (const [family, story] of [
      ["organisms-dialog", "default"],
      ["organisms-bottomsheet", "default"],
      ["templates-gesturessheet", "open"],
      ["templates-hostmcpdialog", "ready"],
      ["templates-sharedialog", "empty"],
      ["templates-bouncedialog", "ready"],
      ["templates-commandpalette", "category-tab"],
      ["templates-editingtoolrail", "confirm-all-dialogue"],
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
          `/iframe.html?id=${family}--docs&viewMode=docs&globals=theme:${theme}`,
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

    for (const [family, story, shell] of [
      ["templates-studioshell", "desktop-inspector", "desktop"],
      ["templates-mobileshell", "phone-360", "phone"],
    ]) {
      test(`${family} keeps its viewport and document state in Docs at ${width} in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 740 });
        await page.emulateMedia({
          colorScheme: theme === "light" ? "light" : "dark",
          reducedMotion: "reduce",
        });
        await page.goto(
          `/iframe.html?id=${family}--docs&viewMode=docs&globals=theme:${theme}`,
        );
        const docs = page;
        const selector = `#story--${family}--${story} iframe`;
        const iframe = docs.locator(selector);
        await expect(iframe).toBeAttached();
        await iframe.scrollIntoViewIfNeeded();
        const frame = docs.frameLocator(selector);
        await expect(frame.locator(".daw-shell")).toBeVisible();
        await expect(frame.locator("html")).toHaveAttribute(
          "data-shell",
          shell,
        );
        await expectInside(frame.locator(".daw-shell"), "viewport");
        await expect(docs.locator("html")).not.toHaveAttribute("data-shell");
        await expect(docs.locator("html")).not.toHaveAttribute("data-layout");
        if (width === 360) {
          const scroll = docs
            .locator(`#story--${family}--${story}`)
            .locator("xpath=ancestor::*[contains(@class, 'docs-story')]");
          expect(
            await scroll.evaluate((el) => el.scrollWidth > el.clientWidth),
          ).toBe(true);
        }
      });
    }
  }
}
