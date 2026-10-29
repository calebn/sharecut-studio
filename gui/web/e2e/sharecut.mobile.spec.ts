import { expect, type Page, test } from "@playwright/test";
import { LONG_PRESS_MS } from "../src/hooks/gestureConstants";
import { timelineTestIds } from "../src/timeline/selectors";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { expectPreviewFooterTouchBounds } from "./inspectorFooterBounds";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { openPhoneTimeline } from "./phoneTimeline";
import {
  collapsePlayer,
  expandPlayer,
  openProject,
  openProjectDialog,
  phone,
  projectMenuButton,
} from "./stageNav";
import { parseTimecodeSec } from "./timecode";

async function expectInspectorFooterTouchTargets(page: Page) {
  const controls = page.locator(".modifier-footer-actions button");
  await expect(controls.first()).toBeVisible();
  expect(await page.evaluate(() => document.doctype?.name)).toBe("html");
  expect(await page.evaluate(() => document.compatMode)).toBe("CSS1Compat");
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: ".modifier-footer-actions button",
    });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(
      fonts.some(
        (font) =>
          font.isCustomFont && /^IBM Plex Sans(?: |$)/.test(font.familyName),
      ),
    ).toBe(true);
  } finally {
    await cdp.detach();
  }
  await expect(
    page.getByRole("button", { name: "Replace audio…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove track", exact: true }),
  ).toBeVisible();
  for (const control of await controls.all()) {
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box?.height, await control.innerText()).toBeGreaterThanOrEqual(44);
    expect(box?.width, await control.innerText()).toBeGreaterThanOrEqual(44);
  }
}

test.describe("ShareCut Studio mobile smoke", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("phone shell shows the tab bar and is axe-clean", async ({ page }) => {
    await openProject(page, e2eProjectPath);

    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "Stages" });
    await expect(tabs).toBeVisible();
    for (const name of ["Record", "Prepare", "Edit", "Review", "Deliver"]) {
      await expect(
        tabs.getByRole("tab", { name: new RegExp(`^${name}\\b`) }),
      ).toBeVisible();
    }
    const surfaces = page.getByRole("group", { name: "Edit surface" });
    await expect(
      surfaces.getByRole("button", { name: "Timeline", exact: true }),
    ).toBeVisible();
    await expect(
      surfaces.getByRole("button", { name: "Script", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Player controls meet the 44pt touch floor: Play in the bar, the skips in
    // the expanded form (the bar hides them on a phone).
    const playBox = await page
      .getByRole("group", { name: "Player" })
      .getByRole("button", { name: "Play", exact: true })
      .boundingBox();
    expect(playBox?.height ?? 0, "Play").toBeGreaterThanOrEqual(44);
    const expanded = await expandPlayer(page);
    for (const name of ["Play", "Back 15 seconds", "Forward 15 seconds"]) {
      const box = await expanded
        .getByRole("button", { name, exact: true })
        .boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    }
    await collapsePlayer(page);

    const shell = page.locator(".stage-frame--phone");
    const body = page.locator(".stage-frame-body");
    const shellBox = await shell.boundingBox();
    const headerBox = await page.locator(".stage-frame-header").boundingBox();
    const bodyBox = await body.boundingBox();
    expect(shellBox).toBeTruthy();
    expect(headerBox).toBeTruthy();
    expect(bodyBox).toBeTruthy();
    expect(bodyBox!.y).toBeGreaterThanOrEqual(
      headerBox!.y + headerBox!.height - 1,
    );

    await openPhoneTimeline(page);
    await expect(page.locator(".timeline-area--fixed-playhead")).toBeVisible();

    await phone.showText(page);
    await expect(page.locator(".phone-edit-script")).toBeVisible();

    // Primary chrome stays in viewport (not cropped)
    const comment = page
      .getByRole("group", { name: "Player" })
      .getByRole("button", { name: "Comment", exact: true });
    const menu = projectMenuButton(page);
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
    await openProject(page, e2eProjectPath);
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
        page.locator(".clip-label", { hasText: lane.name }).first(),
      ).toBeVisible();
    }
    const edges = new Set(lanes.map((lane) => lane.edge));
    expect(edges.size, "each lane keeps its own identity color").toBe(
      lanes.length,
    );
  });

  test("selection More offers live commands in an accessible phone sheet", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await openPhoneTimeline(page);

    await page.locator(".lane-row .clip-block").first().click();
    // A clip opens the compact drawer; at half height it lists the commands.
    const drawer = page.locator(".bottom-sheet--compact");
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Expand to half height" }).click();
    await expect(drawer.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Cut" })).toBeVisible();
    await expectPageAxeClean(page);

    await drawer.getByRole("button", { name: "Close" }).click();
    const sheet = page.getByRole("dialog", { name: "Inspector" });
    await page.locator(".track-header-open").first().click();
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Move track down" }),
    ).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Move track up" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => matchMedia("(pointer: fine)").matches),
    ).toBe(true);
    await expectInspectorFooterTouchTargets(page);
    const trackActions = sheet.getByRole("button", { name: "Track actions" });
    await trackActions.scrollIntoViewIfNeeded();
    const triggerBox = await trackActions.boundingBox();
    expect(triggerBox?.height).toBeGreaterThanOrEqual(44);
    await trackActions.click();
    const smooth = page.getByRole("menuitem", { name: "Smooth all joins" });
    await smooth.scrollIntoViewIfNeeded();
    await expect(smooth).toBeVisible();
    const smoothBox = await smooth.boundingBox();
    expect(smoothBox?.height).toBeGreaterThanOrEqual(44);
    await expectPageAxeClean(page);
  });

  test.describe("fixed playhead at fit zoom (#385)", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    /** Transport time and the ruler time under the fixed center line. */
    const readTimes = (page: Page) =>
      page.evaluate(() => {
        const line = document.querySelector(".playhead--fixed");
        const time = document.querySelector(".timeline-time");
        const now = document.querySelector(
          ".stage-frame-player .sys-player-now",
        );
        const clock = now;
        const scroll = document.querySelector(".timeline-scroll");
        const headers = document.querySelector(
          ".timeline-scroll .track-headers",
        );
        if (!line || !time || !clock || !scroll || !headers) {
          throw new Error("fixed playhead timeline did not mount");
        }
        const lineBox = line.getBoundingClientRect();
        const timeBox = time.getBoundingClientRect();
        const current = (clock.textContent ?? "").trim();
        const total = (
          document.querySelector(".stage-frame-player .sys-player-total")
            ?.textContent ?? ""
        )
          .replace("/", "")
          .trim();
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

    test("loads with time 0 beside the track headers and the playhead on it (#1707)", async ({
      page,
    }) => {
      await openProject(page, e2eProjectPath);
      await openPhoneTimeline(page);
      const t = await readTimes(page);
      // No empty gap: the ruler starts at the headers' edge, the line on it.
      expect(Math.abs(t.timeLeft - t.viewLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(t.lineX - t.viewLeft)).toBeLessThanOrEqual(2);
      expect(parseTimecodeSec(t.current)).toBe(0);
    });

    test("the line sits on the Player time from start to end", async ({
      page,
    }) => {
      await openProject(page, e2eProjectPath);
      // Classic (space-taking) scrollbars on every platform, as on Linux and
      // Windows, with the vertical one showing: the line must sit at the
      // center of the time viewport, which excludes it, not of the area.
      await page.addStyleTag({
        content:
          ".timeline-scroll { overflow-y: scroll; } .timeline-scroll::-webkit-scrollbar { width: 0.75rem; height: 0.75rem; }",
      });
      const player = page.getByRole("group", { name: "Player" });
      await expect(
        player.getByRole("button", { name: "Play", exact: true }),
      ).toBeEnabled();
      const expanded = await expandPlayer(page);
      await expanded
        .getByRole("button", { name: "Forward 15 seconds" })
        .click();
      await collapsePlayer(page);
      await openPhoneTimeline(page);

      // Switching modes must not move the playhead (it once jumped to the end).
      await expect(
        page.locator(".stage-frame-player .sys-player-now"),
      ).toHaveText("00:15.000");
      await expectLineOnTransport(
        page,
        "after the Player skip, on the Timeline",
      );

      // Tap the visible ruler: its left edge walks back to 0 and its right
      // edge out to the end, a viewport at a time. Each tap must seek to the
      // tapped time and leave that time under the line.
      const ruler = await page.getByTestId(timelineTestIds.ruler).boundingBox();
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
      const lane = await page
        .getByTestId(timelineTestIds.lane)
        .first()
        .boundingBox();
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

  test("the Palette opens a truthful, app-level gestures cheatsheet", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await openProjectDialog(page, "gestures");

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

    await gestures
      .getByRole("button", { name: "Commands and shortcuts" })
      .click();
    const keyboard = page.getByRole("dialog", {
      name: "Commands and shortcuts",
    });
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
    // A fresh project has no history head, so Undo would send nothing. Seed a
    // real edit (and put the label back) before the stub below can swallow it.
    const seed = (label: string) =>
      postDocumentCommand(page, "e2e-two-finger-undo", "SetTrackMeta", {
        track_id: "guest",
        label,
      });
    await seed("guest undo seed");
    await seed("guest");
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
    await openProject(page, e2eProjectPath);
    const shell = page.locator(".stage-frame--phone");
    await expect(shell).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeEnabled();
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
    await openProject(page, e2eProjectPath);
    await phone.showText(page);
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
    await openProject(page, e2eProjectPath);
    await phone.showText(page);
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

test.describe("Inspector footer with a desktop coarse pointer", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: true });

  test("every footer control reaches the touch target", async ({ page }) => {
    await openProject(page, e2eProjectPath);
    await expect(page.locator("html")).toHaveAttribute("data-shell", "desktop");
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    await page.locator(".track-header-open").first().press("Enter");
    await expectInspectorFooterTouchTargets(page);
    await openSuggestedPendingEdit(page, e2eProjectPath);
    const inspector = page
      .locator(".modifier-inspector")
      .filter({ has: page.getByRole("heading", { name: "Pending edit" }) });
    await expectPreviewFooterTouchBounds(inspector);
  });
});
