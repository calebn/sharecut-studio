import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openPhoneTimeline } from "./phoneTimeline";

const PHONES = [
  { name: "320x460 portrait", width: 320, height: 460 },
  { name: "320x568 portrait", width: 320, height: 568 },
  { name: "360x520 portrait", width: 360, height: 520 },
  { name: "375x547 portrait (iPhone SE)", width: 375, height: 547 },
  { name: "390x844 portrait", width: 390, height: 844 },
  { name: "460x320 landscape", width: 460, height: 320 },
  { name: "568x320 landscape", width: 568, height: 320 },
  { name: "667x375 landscape", width: 667, height: 375 },
  { name: "844x390 landscape", width: 844, height: 390 },
] as const;

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

test.use({ hasTouch: true });

for (const phone of PHONES) {
  test(`the join popover clears the length grip at ${phone.name}`, async ({
    page,
  }, testInfo) => {
    // Split at a desktop size (the shortcuts need the arrange view), then
    // shrink to the phone, as crossfade-length.spec does.
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const lane = page.locator(".lane-row").first();
    const clips = lane.locator(".clip-block");
    await expect(clips).toHaveCount(1);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(clips).toHaveCount(2);
    let modeChanged = false;
    let lengthChanged = false;
    try {
      await page.setViewportSize({ width: phone.width, height: phone.height });
      if (phone.width < 720) await openPhoneTimeline(page);
      const badge = lane.getByRole("button", { name: /join at/ });
      await badge.scrollIntoViewIfNeeded();
      await badge.click();
      const popover = page.getByRole("dialog", { name: /join at/ });
      await expect(popover).toBeVisible();
      await popover
        .getByRole("button", { name: "Crossfade", exact: true })
        .click();
      modeChanged = true;
      const grip = page.locator(".join-length-grip");
      await expect(grip).toBeVisible();
      const seek = popover.getByRole("button", { name: "Seek join" });
      const audition = popover.getByRole("button", { name: "Audition join" });
      await expect(seek).toBeVisible();
      await expect(audition).toBeVisible();

      const slider = popover.getByRole("slider", { name: "Length" });
      await expect(slider).toBeVisible();
      // The panel re-places after layout, so poll until it settles.
      const checkClear = () =>
        expect(async () => {
          const vp = page.viewportSize();
          const p = await popover.boundingBox();
          const g = await grip.boundingBox();
          const b = await badge.boundingBox();
          if (!vp || !p || !g || !b) throw new Error("missing box");
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.x + p.width).toBeLessThanOrEqual(vp.width + 0.5);
          expect(p.y + p.height).toBeLessThanOrEqual(vp.height + 0.5);
          expect(overlaps(p, g), "popover overlaps the grip").toBe(false);
          expect(overlaps(p, b), "popover overlaps the badge").toBe(false);
          // The badge is centred on the split point, which must stay visible.
          const seamVisible = await page.evaluate(
            ([px, py]) =>
              document.elementFromPoint(px, py)?.closest("[role=dialog]") ==
              null,
            [b.x + b.width / 2, b.y + b.height / 2] as const,
          );
          expect(seamVisible, "popover covers the split point").toBe(true);

          // Nothing but the grip answers at its centre or just inside corners.
          const inset = 2;
          const points = [
            [g.x + g.width / 2, g.y + g.height / 2],
            [g.x + inset, g.y + inset],
            [g.x + g.width - inset, g.y + inset],
            [g.x + inset, g.y + g.height - inset],
            [g.x + g.width - inset, g.y + g.height - inset],
          ] as const;
          for (const [x, y] of points) {
            const hit = await page.evaluate(
              ([px, py]) =>
                document
                  .elementFromPoint(px, py)
                  ?.closest(".join-length-grip") != null,
              [x, y] as const,
            );
            expect(hit, `grip hit at ${x},${y}`).toBe(true);
          }
          await grip.click({ trial: true, timeout: 1000 });

          for (const button of [seek, audition]) {
            await expect(button).toBeVisible();
            // A height-capped panel scrolls; bring the control into view.
            await button.scrollIntoViewIfNeeded({ timeout: 1000 });
            const box = await button.boundingBox();
            if (!box) throw new Error("missing button box");
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
            expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
          }
          for (const control of [seek, audition, slider]) {
            await control.scrollIntoViewIfNeeded({ timeout: 1000 });
            const box = await control.boundingBox();
            if (!box) throw new Error("missing control box");
            expect(
              box.x >= p.x - 0.5 &&
                box.y >= p.y - 0.5 &&
                box.x + box.width <= p.x + p.width + 0.5 &&
                box.y + box.height <= p.y + p.height + 0.5,
              "control inside the popover box",
            ).toBe(true);
          }
        }).toPass({ timeout: 8000 });

      await checkClear();
      const before = await slider.inputValue();
      await slider.focus();
      await page.keyboard.press("End");
      await expect(slider).not.toHaveValue(before);
      lengthChanged = true;
      await checkClear();
      if (phone.width === 844 || phone.width === 568) {
        await page.screenshot({
          path: testInfo.outputPath(`join-popover-${phone.width}.png`),
        });
      }
    } finally {
      await page.keyboard.press("Escape");
      if (lengthChanged) await page.keyboard.press("ControlOrMeta+Z");
      if (modeChanged) {
        await page.keyboard.press("ControlOrMeta+Z");
        await expect(lane.locator(".join-badge--crossfade")).toHaveCount(0);
      }
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(clips).toHaveCount(1);
    }
  });
}
