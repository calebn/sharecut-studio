import { expect, type Page, test } from "@playwright/test";
import { LONG_PRESS_MS } from "../src/hooks/touchGestureTiming";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { openPhoneTimeline } from "./phoneTimeline";
import { parseTimecodeSec } from "./timecode";

test.describe("Sharecut Studio mobile smoke", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("phone shell shows mode nav and is axe-clean", async ({ page }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);

    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Primary" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Listen" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Timeline" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Text" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("button", {
        name: "More",
      }),
    ).toBeVisible();
    await expect(page.locator("header.transport")).toHaveCount(0);
    await expect(page.locator(".listen-hero")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Hero controls meet the 44pt touch floor.
    for (const name of ["Play", "Stop", "−15s", "+15s"]) {
      const box = await page
        .locator(".listen-hero")
        .getByRole("button", { name })
        .boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    }

    const shell = page.locator(".daw-shell--phone");
    const listenBody = page.locator(".mobile-mode-body");
    const shellBox = await shell.boundingBox();
    const listenBodyBox = await listenBody.boundingBox();
    expect(shellBox).toBeTruthy();
    expect(listenBodyBox).toBeTruthy();
    expect(listenBodyBox!.y).toBeLessThanOrEqual(shellBox!.y + 1);

    await openPhoneTimeline(page);
    await expect(page.locator(".timeline-area--fixed-playhead")).toBeVisible();
    await expect(page.locator("header.transport")).toHaveCount(1);
    const timelineBodyBox = await listenBody.boundingBox();
    expect(timelineBodyBox).toBeTruthy();
    expect(timelineBodyBox!.y).toBeGreaterThan(shellBox!.y);

    await page.getByRole("button", { name: "Text" }).click();
    await expect(page.locator(".mobile-text-mode")).toBeVisible();

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "More" })
      .click();
    await expect(page.locator(".mobile-more-hub")).toBeVisible();

    // Primary chrome stays in viewport (not cropped)
    const comment = page.getByRole("button", { name: "Comment", exact: true });
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(comment).toBeVisible();
    await expect(menu).toBeVisible();
    const vw = page.viewportSize()?.width ?? 390;
    for (const loc of [comment, menu]) {
      const box = await loc.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 1);
    }

    await expectPageAxeClean(page);
  });

  test("phone lanes show who each track is", async ({ page }) => {
    // Identity first (#20 review): a lane-colored initials chip per lane, the
    // lane color on the rail edge, and the full name on the lane's clips.
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await openPhoneTimeline(page);
    const lanes = await page.evaluate(() =>
      [...document.querySelectorAll(".track-header-row")].map((row) => {
        const chip = row.querySelector(".track-chip");
        const box = chip?.getBoundingClientRect();
        const name =
          row
            .querySelector(".track-header-open")
            ?.getAttribute("aria-label")
            ?.replace("Open track details, ", "") ?? "";
        return {
          name,
          chip: chip?.textContent ?? "",
          size: box ? [Math.round(box.width), Math.round(box.height)] : [0, 0],
          edge: getComputedStyle(row).borderInlineStartColor,
        };
      }),
    );
    expect(lanes.length).toBeGreaterThan(1);
    for (const lane of lanes) {
      expect(lane.chip, lane.name).toMatch(/^[A-Z?]{1,2}$/);
      expect(lane.size[0], lane.name).toBeGreaterThanOrEqual(44);
      expect(lane.size[1], lane.name).toBeGreaterThanOrEqual(44);
      await expect(
        page.locator(".clip-label-track", { hasText: lane.name }).first(),
      ).toBeVisible();
    }
    const edges = new Set(lanes.map((lane) => lane.edge));
    expect(edges.size, "each lane keeps its own identity color").toBe(
      lanes.length,
    );
  });

  test.describe("fixed playhead at fit zoom (#385)", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    /** Transport time and the ruler time under the fixed center line. */
    const readTimes = (page: Page) =>
      page.evaluate(() => {
        const line = document.querySelector(".playhead--fixed");
        const time = document.querySelector(".timeline-time");
        const clock = document.querySelector(".transport .timecode");
        const scroll = document.querySelector(".timeline-scroll");
        const headers = document.querySelector(
          ".timeline-scroll .track-headers",
        );
        if (!line || !time || !clock || !scroll || !headers) {
          throw new Error("fixed playhead timeline did not mount");
        }
        const lineBox = line.getBoundingClientRect();
        const timeBox = time.getBoundingClientRect();
        const [current, total] = (clock.getAttribute("title") ?? "").split(
          " / ",
        );
        return {
          lineX: lineBox.left + lineBox.width / 2,
          timeLeft: timeBox.left,
          timeWidth: timeBox.width,
          viewLeft: headers.getBoundingClientRect().right,
          // Past a classic scrollbar, a tap lands on the scrollbar.
          viewRight:
            scroll.getBoundingClientRect().left +
            scroll.clientLeft +
            scroll.clientWidth,
          current,
          total,
        };
      });

    // Two CSS pixels of ruler at fit zoom.
    const toleranceSec = (t: { total: string; timeWidth: number }) =>
      Math.max(0.25, (2 * parseTimecodeSec(t.total)) / t.timeWidth);

    const expectLineOnTransport = async (page: Page, label: string) => {
      await expect
        .poll(async () => {
          const t = await readTimes(page);
          const totalSec = parseTimecodeSec(t.total);
          const lineSec = ((t.lineX - t.timeLeft) / t.timeWidth) * totalSec;
          return (
            Math.abs(lineSec - parseTimecodeSec(t.current)) <= toleranceSec(t)
          );
        }, label)
        .toBe(true);
    };

    test("the line sits on the transport time from start to end", async ({
      page,
    }) => {
      await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
      // Classic (space-taking) scrollbars on every platform, as on Linux and
      // Windows, with the vertical one showing: the line must sit at the
      // center of the time viewport, which excludes it, not of the area.
      await page.addStyleTag({
        content:
          ".timeline-scroll { overflow-y: scroll; } .timeline-scroll::-webkit-scrollbar { width: 0.75rem; height: 0.75rem; }",
      });
      const hero = page.locator(".listen-hero");
      await expect(hero.getByRole("button", { name: "Play" })).toBeEnabled();
      await hero.getByRole("button", { name: "+15s" }).click();
      await openPhoneTimeline(page);

      // Switching modes must not move the playhead (it once jumped to the end).
      await expect(page.locator(".transport .timecode-current")).toHaveText(
        "00:15.000",
      );
      await expectLineOnTransport(page, "after Listen → Timeline");

      // Tap the visible ruler: its left edge walks back to 0 and its right
      // edge out to the end, a viewport at a time. Each tap must seek to the
      // tapped time and leave that time under the line.
      const ruler = await page.locator(".time-ruler").boundingBox();
      expect(ruler).toBeTruthy();
      const reached: number[] = [];
      for (const edge of ["start", "end", "end", "end"] as const) {
        const t = await readTimes(page);
        const totalSec = parseTimecodeSec(t.total);
        const x =
          edge === "start"
            ? Math.max(t.timeLeft, t.viewLeft) + 1
            : Math.min(t.timeLeft + t.timeWidth, t.viewRight) - 1;
        const tapped = Math.min(
          totalSec,
          Math.max(0, ((x - t.timeLeft) / t.timeWidth) * totalSec),
        );
        await page.mouse.click(x, ruler!.y + ruler!.height / 2);
        await expect
          .poll(async () => {
            const now = await readTimes(page);
            return Math.abs(parseTimecodeSec(now.current) - tapped);
          }, `seek toward the ${edge}`)
          .toBeLessThanOrEqual(toleranceSec(t));
        await expectLineOnTransport(page, `after a seek toward the ${edge}`);
        reached.push(parseTimecodeSec((await readTimes(page)).current));
      }
      // A person's horizontal scroll (the scrub gesture) seeks too.
      const view = await readTimes(page);
      const lane = await page.locator(".lane-row").first().boundingBox();
      expect(lane).toBeTruthy();
      await page.mouse.move(
        (view.viewLeft + view.viewRight) / 2,
        lane!.y + lane!.height / 2,
      );
      await page.mouse.wheel(-120, 0);
      await expect
        .poll(
          async () => parseTimecodeSec((await readTimes(page)).current),
          "a wheel scrub seeks back",
        )
        .toBeLessThan(parseTimecodeSec(view.current) - 1);
      await expectLineOnTransport(page, "after a wheel scrub");

      const t = await readTimes(page);
      expect(reached[0], "reaches the start").toBeLessThanOrEqual(
        toleranceSec(t),
      );
      expect(reached.at(-1), "reaches the end").toBeGreaterThanOrEqual(
        parseTimecodeSec(t.total) - toleranceSec(t),
      );
    });
  });

  test("More opens a truthful, app-level gestures cheatsheet", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "More" })
      .click();

    const trigger = page.getByRole("button", { name: "Gestures" });
    await trigger.click();

    const gestures = page.getByRole("dialog", { name: "Gestures" });
    await expect(gestures).toBeVisible();
    await expect(
      gestures.locator("xpath=ancestor::*[@data-daw-app-chrome]"),
    ).toHaveCount(0);
    await expect(page.locator("[data-daw-app-chrome]")).toHaveAttribute(
      "inert",
      "",
    );
    await expect(
      gestures.getByText("Two-finger tap").locator("xpath=.."),
    ).not.toContainText("Soon");
    await expect(
      gestures.getByText("Long-press").locator("xpath=.."),
    ).not.toContainText("Soon");
    await expect(
      gestures.getByText("Pinch").locator("xpath=.."),
    ).not.toContainText("Soon");

    await gestures.getByRole("button", { name: "Keyboard shortcuts" }).click();
    const keyboard = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(keyboard).toBeVisible();
    await expect(gestures).toHaveCount(0);

    await keyboard.getByRole("button", { name: "Gestures" }).click();
    await expect(page.getByRole("dialog", { name: "Gestures" })).toBeVisible();
    await expect(keyboard).toHaveCount(0);
  });

  test("a sequential two-finger tap sends UndoHistory through the command bus", async ({
    page,
    context,
  }) => {
    // Verify dispatch without undoing another test's changes to the shared
    // disposable project. The following gesture tests need its transcript.
    await page.route("**/api/document/command?*", async (route) => {
      const command = route.request().postDataJSON() as {
        type?: string;
      } | null;
      if (command?.type !== "UndoHistory") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    const shell = page.locator(".daw-shell--phone");
    await expect(shell).toBeVisible();
    await expect(page.locator(".mobile-listen[aria-busy='true']")).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
    const box = await shell.boundingBox();
    expect(box).toBeTruthy();

    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 2,
    });
    const first = { x: box!.x + 80, y: box!.y + 80, id: 1 };
    const second = { x: box!.x + 140, y: box!.y + 80, id: 2 };
    const undoRequest = page.waitForRequest((request) => {
      if (new URL(request.url()).pathname !== "/api/document/command")
        return false;
      return request.postDataJSON()?.type === "UndoHistory";
    });

    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [first],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [first, second],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [second],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    const request = await undoRequest;
    expect(request.postDataJSON()).toMatchObject({ type: "UndoHistory" });
  });

  test("touch long-press opens the selected transcript word sheet", async ({
    page,
    context,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await page.getByRole("button", { name: "Text" }).click();
    // The first transcript chip can be a temporary turn-level placeholder.
    const word = page
      .locator('[data-transcript-word][data-word-index="0"]')
      .first();
    await expect(word).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    const box = await word.boundingBox();
    expect(box).toBeTruthy();
    const point = {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
      id: 1,
    };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    // Hold past the shared threshold; the recognizer fires only on release,
    // so there is no earlier UI state to poll for.
    await page.waitForTimeout(LONG_PRESS_MS + 150);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await expect(page.getByLabel("Corrected text")).toBeVisible();
  });

  test("touch double-tap opens word correction", async ({ page, context }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await page.getByRole("button", { name: "Text" }).click();
    // Wait for a word-level chip before capturing coordinates for both taps.
    const word = page
      .locator('[data-transcript-word][data-word-index="0"]')
      .first();
    await expect(word).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    const box = await word.boundingBox();
    expect(box).toBeTruthy();
    const point = {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
      id: 1,
    };
    for (let tap = 0; tap < 2; tap += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    }
    await expect(word).toHaveClass(/selected/);
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await expect(page.getByLabel("Corrected text")).toBeVisible();
  });
});
