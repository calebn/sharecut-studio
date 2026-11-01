import { expect, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

const SIZES = [
  { width: 320, height: 568, script: true },
  { width: 390, height: 844, script: true },
  { width: 844, height: 390, script: false },
  { width: 1280, height: 800, script: true },
  { width: 800, height: 1280, script: true },
] as const;

for (const size of SIZES) {
  test(`a Commenter link ${size.script ? "shows" : "hides"} the read-only Script and keeps the composer in view at ${size.width}x${size.height}`, async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          {},
          {
            viewport: { width: size.width, height: size.height },
            hasTouch: size.width < 900,
          },
        ],
        async ([host, guest]) => {
          await openHostShare(host, projectPath);
          const token = await createReviewShare(host, projectPath, "commenter");
          await openGuestShare(guest, token);
          const script = guest.locator(".stage-host-guest-script");
          if (size.script) {
            await expect(script).toBeVisible();
            await expect(script).toContainText("Read only");
            await expect(script).toBeInViewport();
          } else {
            await expect(script).toHaveCount(0);
          }
          const field = guest
            .locator(".rv-compose")
            .getByRole("textbox", { name: "Comment", exact: true });
          await expect(field).toBeInViewport();
          await expect
            .poll(() =>
              guest.evaluate(() => document.documentElement.scrollWidth),
            )
            .toBeLessThanOrEqual(size.width);
        },
      );
    });
  });
}

test("a Viewer link shows no Script, because its guests are not sent word timings", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
      await openHostShare(host, projectPath);
      const token = await createReviewShare(host, projectPath, "viewer");
      await openGuestShare(guest, token);
      await expect(guest.locator(".rv-stage")).toBeVisible();
      await expect(guest.locator(".stage-host-guest-script")).toHaveCount(0);
      await expect(guest.getByText("Nothing to read yet")).toHaveCount(0);
    });
  });
});

test("a Commenter keeps readable Script through native page zoom and viewport recovery", async ({
  browser,
}, info) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        },
      ],
      async ([host, guest]) => {
        await openHostShare(host, projectPath);
        const token = await createReviewShare(host, projectPath, "commenter");
        await openGuestShare(guest, token);
        const script = guest.locator(".stage-host-guest-script");
        const word = script.locator('.sys-script-word[tabindex="0"]').first();
        const field = guest.locator(".rv-compose").getByRole("textbox", {
          name: "Comment",
          exact: true,
        });
        const cdp = await guest.context().newCDPSession(guest);
        const observations: object[] = [];
        const observe = () =>
          guest.evaluate(() => {
            const visual = window.visualViewport;
            if (!visual) throw new Error("Native visual viewport is required");
            const measure = (element: Element | null) => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              let left = visual.offsetLeft;
              let top = visual.offsetTop;
              let right = left + visual.width;
              let bottom = top + visual.height;
              let painted = true;
              for (
                let node: Element | null = element;
                node;
                node = node.parentElement
              ) {
                const style = getComputedStyle(node);
                painted &&=
                  style.display !== "none" && style.visibility === "visible";
                if (node === element) continue;
                const box = node.getBoundingClientRect();
                if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
                  left = Math.max(left, box.left + node.clientLeft);
                  right = Math.min(
                    right,
                    box.left + node.clientLeft + node.clientWidth,
                  );
                }
                if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
                  top = Math.max(top, box.top + node.clientTop);
                  bottom = Math.min(
                    bottom,
                    box.top + node.clientTop + node.clientHeight,
                  );
                }
              }
              const style = getComputedStyle(element);
              return {
                rect: rect.toJSON(),
                visibleWidth: painted
                  ? Math.max(
                      0,
                      Math.min(right, rect.right) - Math.max(left, rect.left),
                    )
                  : 0,
                visibleHeight: painted
                  ? Math.max(
                      0,
                      Math.min(bottom, rect.bottom) - Math.max(top, rect.top),
                    )
                  : 0,
                fontSize: Number.parseFloat(style.fontSize),
                color: style.color,
                background: style.backgroundColor,
                text: element.textContent?.trim().slice(0, 80),
              };
            };
            return {
              layout: { width: innerWidth, height: innerHeight },
              visual: {
                width: visual.width,
                height: visual.height,
                scale: visual.scale,
                offsetLeft: visual.offsetLeft,
                offsetTop: visual.offsetTop,
              },
              mediaShort: matchMedia("(max-height: 30rem)").matches,
              documentWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              scriptCount: document.querySelectorAll(".stage-host-guest-script")
                .length,
              word: measure(
                document.querySelector(
                  '.stage-host-guest-script .sys-script-word[tabindex="0"]',
                ),
              ),
              field: measure(document.querySelector(".rv-compose textarea")),
              styled:
                getComputedStyle(
                  document.querySelector(".rv-stage") ?? document.body,
                ).display === "flex",
            };
          });
        const nativeTabTo = async (target: typeof word) => {
          const tabStops = await guest.evaluate(
            () =>
              Array.from(
                document.querySelectorAll<HTMLElement>(
                  'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]',
                ),
              ).filter((element) => {
                const style = getComputedStyle(element);
                return (
                  element.tabIndex >= 0 &&
                  !element.matches(":disabled") &&
                  !element.closest("[inert]") &&
                  style.visibility === "visible" &&
                  element.getClientRects().length > 0
                );
              }).length,
          );
          for (let step = 0; step <= tabStops; step++) {
            if (
              await target.evaluate(
                (element) => element === document.activeElement,
              )
            ) {
              await expect(target).toBeFocused();
              return;
            }
            await guest.keyboard.press("Tab");
          }
          await expect(target).toBeFocused();
        };
        const capture = async (name: string, shown: boolean, scale = 1) => {
          await expect(script).toHaveCount(shown ? 1 : 0);
          if (shown) {
            await expect(script).toContainText("Read only");
            await nativeTabTo(word);
            await expect
              .poll(async () => (await observe()).word?.visibleWidth ?? 0)
              .toBeGreaterThan(0);
            await expect
              .poll(async () => (await observe()).word?.visibleHeight ?? 0)
              .toBeGreaterThan(0);
            const reading = await observe();
            expect(reading.visual.scale).toBe(scale);
            expect(reading.word?.text).toBeTruthy();
            expect(reading.word?.visibleWidth).toBeGreaterThanOrEqual(
              (reading.word?.rect.width ?? 0) - 1,
            );
            expect(reading.word?.visibleHeight).toBeGreaterThanOrEqual(
              (reading.word?.rect.height ?? 0) - 1,
            );
            expect(reading.word?.fontSize).toBeGreaterThanOrEqual(12);
            expect(reading.styled).toBe(true);
            observations.push({
              checkpoint: name,
              purpose: "read-script",
              ...reading,
            });
            await info.attach(`guest-script-${name}`, {
              body: await guest.screenshot(),
              contentType: "image/png",
            });
          }
          await expect(field).toBeEditable();
          await nativeTabTo(field);
          await expect
            .poll(async () => (await observe()).field?.visibleWidth ?? 0)
            .toBeGreaterThanOrEqual(44);
          await expect
            .poll(async () => (await observe()).field?.visibleHeight ?? 0)
            .toBeGreaterThanOrEqual(20);
          await guest.keyboard.type("Viewport proof");
          await expect(field).toHaveValue("Viewport proof");
          await guest.keyboard.press("ControlOrMeta+A");
          await guest.keyboard.press("Backspace");
          await expect(field).toHaveValue("");
          const composing = await observe();
          expect(composing.visual.scale).toBe(scale);
          expect(composing.documentWidth).toBeLessThanOrEqual(
            composing.clientWidth,
          );
          observations.push({
            checkpoint: name,
            purpose: "use-comment-field",
            ...composing,
          });
          await info.attach(`guest-composer-${name}`, {
            body: await guest.screenshot(),
            contentType: "image/png",
          });
        };
        let bodyFailed = false;
        try {
          await expect.poll(async () => (await observe()).visual.scale).toBe(1);
          await capture("initial", true);
          await cdp.send("Emulation.setPageScaleFactor", {
            pageScaleFactor: 2,
          });
          await expect.poll(async () => (await observe()).visual.scale).toBe(2);
          await expect
            .poll(async () => (await observe()).visual.height)
            .toBe(422);
          expect((await observe()).layout.height).toBe(844);
          expect((await observe()).mediaShort).toBe(false);
          await capture("native-zoom-2x", true, 2);
          await cdp.send("Emulation.setPageScaleFactor", {
            pageScaleFactor: 1,
          });
          await expect.poll(async () => (await observe()).visual.scale).toBe(1);
          await capture("zoom-reset", true);
          for (const checkpoint of [
            { height: 460, shown: false, mediaShort: true },
            { height: 500, shown: false, mediaShort: false },
            { height: 519, shown: false, mediaShort: false },
            { height: 520, shown: true, mediaShort: false },
          ]) {
            await guest.setViewportSize({
              width: 390,
              height: checkpoint.height,
            });
            await expect
              .poll(async () => (await observe()).visual.height)
              .toBe(checkpoint.height);
            expect((await observe()).visual.scale).toBe(1);
            expect((await observe()).mediaShort).toBe(checkpoint.mediaShort);
            await capture(`recovery-${checkpoint.height}`, checkpoint.shown);
          }
        } catch (error) {
          bodyFailed = true;
          throw error;
        } finally {
          const cleanupFailures: unknown[] = [];
          try {
            await info.attach("guest-viewport-observations", {
              body: Buffer.from(
                JSON.stringify({
                  browserVersion: browser.version(),
                  observations,
                }),
              ),
              contentType: "application/json",
            });
          } catch (error) {
            cleanupFailures.push(error);
          }
          try {
            await cdp.detach();
          } catch (error) {
            cleanupFailures.push(error);
          }
          if (!bodyFailed && cleanupFailures.length > 0)
            throw new AggregateError(
              cleanupFailures,
              "Guest proof cleanup failed",
            );
        }
      },
    );
  });
});
