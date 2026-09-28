import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

/** The popover lies inside the viewport and does not cover its badge. */
async function expectPlacedBeside(
  page: Page,
  popover: Locator,
  badge: Locator,
) {
  // The panel re-places from a ResizeObserver notification, which a real
  // browser delivers after layout, so poll until it settles.
  await expect(async () => {
    const vp = page.viewportSize();
    const p = await popover.boundingBox();
    const b = await badge.boundingBox();
    if (!vp || !p || !b) throw new Error("missing box");
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y + p.height).toBeLessThanOrEqual(vp.height);
    expect(p.x + p.width).toBeLessThanOrEqual(vp.width);
    const overlaps =
      p.x < b.x + b.width &&
      b.x < p.x + p.width &&
      p.y < b.y + b.height &&
      b.y < p.y + p.height;
    expect(overlaps).toBe(false);
  }).toPass();
}

test.describe("Join badge popover", () => {
  test("the join badge opens a popover that changes the join mode", async ({
    page,
  }) => {
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
    try {
      const badge = lane.getByRole("button", { name: /join at/ });
      // The hit area is 24 px wide at any root font size: points 11 px either
      // side of the badge's centre hit it (the badge itself is 1rem).
      const expectHitAreaReaches24px = async () => {
        const box = await badge.boundingBox();
        if (!box) throw new Error("join badge has no box");
        for (const dx of [-11, 11]) {
          const hit = await page.evaluate(
            ([x, y]) =>
              document.elementFromPoint(x, y)?.closest(".join-badge") != null,
            [box.x + box.width / 2 + dx, box.y + box.height / 2] as const,
          );
          expect(hit).toBe(true);
        }
      };
      await expectHitAreaReaches24px();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "12px";
      });
      try {
        await expectHitAreaReaches24px();
      } finally {
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "";
        });
      }
      await badge.click();
      const popover = page.getByRole("dialog", { name: /join at/ });
      await expect(popover).toBeVisible();
      await expect(badge).toHaveAttribute("aria-expanded", "true");
      await expectPageAxeClean(page, ".join-popover");
      await popover
        .getByRole("button", { name: "Crossfade", exact: true })
        .click();
      await expect(lane.locator(".join-badge--crossfade")).toHaveCount(1);
      modeChanged = true;
      await expect(
        popover.getByRole("button", { name: "Crossfade", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        popover.getByRole("slider", { name: "Length" }),
      ).toBeVisible();
      await expect(
        popover.getByRole("button", { name: "Audition join" }),
      ).toBeVisible();
      await expectPageAxeClean(page, ".join-popover");
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      await expect(badge).toBeFocused();
    } finally {
      await page.keyboard.press("Escape");
      if (modeChanged) {
        await page.keyboard.press("ControlOrMeta+Z");
        await expect(lane.locator(".join-badge--crossfade")).toHaveCount(0);
      }
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(clips).toHaveCount(1);
    }
  });

  test("the popover re-places when a mode change resizes it near the bottom edge", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    // The second lane sits far enough from the top of the viewport that the
    // popover (opened above, since we leave no room below) has headroom of
    // its own; the first lane's badge is too close to the top for that.
    const lane = page.locator(".lane-row").nth(1);
    const clips = lane.locator(".clip-block");
    await expect(clips).toHaveCount(1);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(clips).toHaveCount(2);
    // Maximize the timeline so the bottom Transcript/Pipeline tabs (pinned
    // to a minimum height) don't sit over the badge once the window shrinks.
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("ControlOrMeta+2");
    const original = page.viewportSize();
    let modeChanges = 0;
    try {
      const badge = lane.getByRole("button", { name: /join at/ });
      // Open at the window's natural size (room below, no scroll needed).
      await badge.click();
      const popover = page.getByRole("dialog", { name: /join at/ });
      await expect(popover).toBeVisible();
      await expect(
        popover.getByRole("button", { name: "Fade", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      // Cut drops the Length row (the panel shrinks) while the window is
      // still full size, so this alone proves nothing about re-placement.
      await popover.getByRole("button", { name: "Cut", exact: true }).click();
      await expect(lane.locator(".join-badge--cut")).toHaveCount(1);
      modeChanges += 1;
      await expect(popover.getByRole("slider", { name: "Length" })).toHaveCount(
        0,
      );
      // Now shrink the window so the popover has to re-place above the
      // badge, sized for the current (Cut) panel — via the window resize
      // listener, not the panel's own observer.
      const box = await badge.boundingBox();
      if (!box || !original) throw new Error("join badge has no box");
      await page.setViewportSize({
        width: original.width,
        height: Math.ceil(box.y + box.height + 8),
      });
      await expectPlacedBeside(page, popover, badge);
      // Fade brings the Length row back (the panel grows) with the window
      // already small: only the panel's own ResizeObserver — not a window
      // resize — can catch this and re-place, which is what this pins.
      await popover.getByRole("button", { name: "Fade", exact: true }).click();
      await expect(lane.locator(".join-badge--fade")).toHaveCount(1);
      modeChanges += 1;
      await expect(
        popover.getByRole("slider", { name: "Length" }),
      ).toBeVisible();
      await expectPlacedBeside(page, popover, badge);
    } finally {
      await page.keyboard.press("Escape");
      if (original) await page.setViewportSize(original);
      for (let i = 0; i < modeChanges; i += 1) {
        await page.keyboard.press("ControlOrMeta+Z");
      }
      await expect(lane.locator(".join-badge--cut")).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(clips).toHaveCount(1);
    }
  });
});
