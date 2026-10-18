import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "../e2e/axe";
import {
  acceptedEnvelopeCommand,
  envelopeSnapshot,
  envelopeTrack,
  openEnvelopeTrackDetails,
} from "../e2e/envelopeCreationEvidence";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";

test.use({ hasTouch: true, reducedMotion: "reduce" });

async function pointerGeometry(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      rect: rect.toJSON(),
      hit: hit === element || (hit !== null && element.contains(hit)),
      viewport: {
        width: innerWidth,
        height:
          (visualViewport?.offsetTop ?? 0) +
          (visualViewport?.height ?? innerHeight),
      },
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
    };
  });
}

async function expectPointerControl(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  const { rect, hit, viewport } = await pointerGeometry(control);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(viewport.width);
  expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
  expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(hit).toBe(true);
}

async function envelopeGeometry(page: Page, trackId: string) {
  return page.evaluate((trackId) => {
    const box = (element: Element | null) =>
      element?.getBoundingClientRect().toJSON() ?? null;
    const lane = document.querySelector(
      `.lane-row[data-track-id="${CSS.escape(trackId)}"]`,
    );
    if (!lane?.querySelector(".envelope-overlay"))
      throw new Error("Edited track has no visible envelope overlay");
    const rect = lane?.getBoundingClientRect();
    const x = rect ? Math.min(innerWidth - 16, rect.right - 16) : 0;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const hit = document.elementFromPoint(x, y);
    return {
      sheet: box(document.querySelector(".bottom-sheet")),
      lane: box(lane),
      laneHit: lane !== null && hit !== null && lane.contains(hit),
      status: box(document.querySelector(".mobile-status-row .save-dot")),
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, trackId);
}

const layouts: {
  width: number;
  height: number;
  label?: string;
  rootFontSize?: number;
  keyboardHeight?: number;
  trackIndex?: number;
}[] = [
  { width: 568, height: 320 },
  { width: 667, height: 375 },
  { width: 740, height: 360 },
  { width: 767, height: 375 },
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 740, height: 568, label: "scrolled track and Solo", trackIndex: 1 },
  { width: 767, height: 375, label: "larger text", rootFontSize: 20 },
  { width: 667, height: 375, label: "synthetic keyboard", keyboardHeight: 225 },
];

for (const viewport of layouts) {
  test(`phone envelope at ${viewport.width}x${viewport.height}${viewport.label ? ` ${viewport.label}` : ""} keeps its lane and controls reachable`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await withShareableProject(async (projectPath) => {
      await openHostShare(page, projectPath);
      if (viewport.rootFontSize)
        await page.addStyleTag({
          content: `:root { font-size: ${viewport.rootFontSize}px; }`,
        });
      await openPhoneTimeline(page);
      const track =
        viewport.trackIndex === undefined
          ? envelopeTrack(projectPath)
          : (
              JSON.parse(readFileSync(projectPath, "utf8")) as {
                timeline: { tracks: { id: string; label: string }[] };
              }
            ).timeline.tracks[viewport.trackIndex];
      await openEnvelopeTrackDetails(page, track.label, []);
      if (viewport.trackIndex !== undefined) {
        await page
          .getByRole("dialog")
          .getByRole("button", { name: `Solo ${track.label}`, exact: true })
          .tap();
        await expect(
          page.locator(".mobile-status-row .solo-chip"),
        ).toBeVisible();
      }
      await page
        .getByRole("button", { name: "Add volume envelope", exact: true })
        .tap();
      await page
        .getByRole("button", { name: "Show volume envelope", exact: true })
        .tap();
      await page.getByRole("button", { name: "Add point", exact: true }).tap();
      if (viewport.keyboardHeight) {
        await page.evaluate((height) => {
          if (!visualViewport) throw new Error("Visual viewport unavailable");
          Object.defineProperty(visualViewport, "height", {
            configurable: true,
            get: () => height,
          });
          visualViewport.dispatchEvent(new Event("resize"));
        }, viewport.keyboardHeight);
        await expect(page.locator("html")).toHaveAttribute(
          "data-keyboard",
          "open",
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
      }
      const controls = {
        time: page.getByLabel("Time (seconds on timeline)", { exact: true }),
        level: page.getByLabel("Level (×)", { exact: true }),
        save: page.getByRole("button", { name: "Save point", exact: true }),
        cancel: page.getByRole("button", { name: "Cancel", exact: true }),
        done: page.getByRole("button", { name: "Done", exact: true }),
        close: page
          .getByRole("dialog")
          .getByRole("button", { name: "Close", exact: true }),
        expand: page
          .getByRole("dialog")
          .getByRole("button", { name: "Expand", exact: true }),
      };
      const geometry = await envelopeGeometry(page, track.id);
      await info.attach("phone-envelope-geometry", {
        body: JSON.stringify(
          {
            ...geometry,
            controls: Object.fromEntries(
              await Promise.all(
                Object.entries(controls).map(async ([name, control]) => [
                  name,
                  await pointerGeometry(control),
                ]),
              ),
            ),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await info.attach("phone-envelope-form", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      expect(geometry.lane).not.toBeNull();
      expect(geometry.sheet).not.toBeNull();
      expect(geometry.status).not.toBeNull();
      expect(geometry.lane!.top).toBeGreaterThanOrEqual(0);
      if (viewport.width > viewport.height && !viewport.keyboardHeight) {
        expect(geometry.lane!.bottom).toBeLessThanOrEqual(geometry.sheet!.top);
        expect(geometry.laneHit).toBe(true);
        await expect(
          page.locator(".bottom-sheet-header").getByRole("heading"),
        ).toHaveCount(1);
      }
      expect(geometry.status!.bottom).toBeLessThanOrEqual(geometry.sheet!.top);
      await expect(
        page.locator(".mobile-status-row .save-dot"),
      ).toHaveAttribute("aria-label", /\S/);
      for (const control of Object.values(controls)) {
        if (viewport.width < viewport.height)
          await control.scrollIntoViewIfNeeded();
        await expectPointerControl(control);
      }
      for (const field of [controls.time, controls.level]) {
        expect((await pointerGeometry(field)).fontSize).toBeGreaterThanOrEqual(
          16,
        );
        await field.tap();
      }
      if (viewport.trackIndex !== undefined) {
        const unchanged = envelopeSnapshot(projectPath, track.id);
        await controls.time.fill("2");
        await controls.level.fill("0.5");
        await expectPointerControl(controls.cancel);
        await controls.cancel.tap();
        await expect(controls.time).toHaveCount(0);
        expect(envelopeSnapshot(projectPath, track.id)).toEqual(unchanged);
        await expectPointerControl(controls.done);
        await controls.done.tap();
        await expect(page.locator(".envelope-workspace")).toHaveCount(0);
        return;
      }
      if (viewport.width === 667 && !viewport.label) {
        await expectPageAxeClean(page, ".bottom-sheet");
        const help = page.getByRole("button", {
          name: "Volume envelope help",
          exact: true,
        });
        await help.tap();
        await expect(
          page.getByText(/Time is measured on the timeline/),
        ).toBeVisible();
        await expectPointerControl(controls.done);
        await expectPointerControl(controls.close);
        await help.tap();
        await expect(
          page.getByText(/Time is measured on the timeline/),
        ).toBeHidden();
      }
      await controls.time.fill("1");
      await controls.level.fill("0.75");
      if (viewport.width === 667 && !viewport.label) {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(controls.time).toHaveValue("1");
        await expect(controls.level).toHaveValue("0.75");
        await page.setViewportSize({ width: 667, height: 375 });
        await expectPointerControl(controls.time);
        await expectPointerControl(controls.level);
      }
      await acceptedEnvelopeCommand(page, "SetEnvelope", () =>
        controls.save.tap(),
      );
      await expect
        .poll(() => envelopeSnapshot(projectPath, track.id).points)
        .toContainEqual(expect.objectContaining({ time: 1, value: 0.75 }));
      const saved = envelopeSnapshot(projectPath, track.id);
      await page.getByRole("button", { name: "Add point", exact: true }).tap();
      await controls.time.fill("2");
      await controls.level.fill("0.5");
      if (viewport.width < viewport.height)
        await controls.cancel.scrollIntoViewIfNeeded();
      await expectPointerControl(controls.cancel);
      await controls.cancel.tap();
      await expect(controls.time).toHaveCount(0);
      expect(envelopeSnapshot(projectPath, track.id)).toEqual(saved);
      if (viewport.keyboardHeight) {
        await page.evaluate(() => {
          if (!visualViewport) throw new Error("Visual viewport unavailable");
          Object.defineProperty(visualViewport, "height", {
            configurable: true,
            get: () => innerHeight,
          });
          visualViewport.dispatchEvent(new Event("resize"));
        });
        await expect(page.locator("html")).not.toHaveAttribute(
          "data-keyboard",
          "open",
        );
        await expect
          .poll(async () => {
            const restored = await envelopeGeometry(page, track.id);
            return restored.lane!.bottom - restored.sheet!.top;
          })
          .toBeLessThanOrEqual(0);
      }
      if (viewport.width < viewport.height)
        await controls.done.scrollIntoViewIfNeeded();
      await expectPointerControl(controls.done);
      await controls.done.tap();
      await expect(page.locator(".envelope-workspace")).toHaveCount(0);
      await expect(
        page.locator(".mobile-status-row .save-dot"),
      ).toHaveAttribute("data-save-state", "saved");
    });
  });
}
