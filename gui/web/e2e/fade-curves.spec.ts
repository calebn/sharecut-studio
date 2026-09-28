import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

type Box = { x: number; y: number; width: number; height: number };

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

test.describe("Timeline fade curves", () => {
  test("drags a hover-revealed corner handle into a drawn fade", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const clip = page.locator(".lane-row").first().locator(".clip-block");
    await expect(clip).toHaveCount(1);
    const corner = clip.locator("button.fade-corner.in");
    const lines = clip.locator(".clip-fade-line");
    await expect(lines).toHaveCount(0);
    // Zero-length fade: transparent and click-through until the clip is hovered.
    await page.mouse.move(0, 0);
    await expect(corner).toHaveCSS("opacity", "0");
    await expect(corner).toHaveCSS("pointer-events", "none");
    await clip.hover();
    await expect(corner).toHaveCSS("opacity", "1");
    await expect(corner).toHaveCSS("pointer-events", "auto");
    await expect(clip.locator(".trim-handle.in")).toHaveCSS("opacity", "1");
    try {
      const box = await corner.boundingBox();
      if (!box) throw new Error("fade corner has no box");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 40, y, { steps: 5 });
      await expect(clip.locator(".fade-readout.in")).toHaveText(/^\d+ ms$/);
      await page.mouse.up();
      await expect(lines).toHaveCount(1);
      await expect(corner).not.toHaveClass(/\bzero\b/);
      await expectPageAxeClean(page, ".lane-row .clip-block");
    } finally {
      // Leave the shared live E2E project as later specs expect it; undo only
      // our own fade so a failed drag never undoes another spec's edit.
      if ((await lines.count()) > 0) {
        await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+Z");
        await expect(lines).toHaveCount(0);
      }
    }
  });

  test("reveals trim strips and zero fade corners on keyboard focus, both Tab directions", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const clip = page.locator(".lane-row").first().locator(".clip-block");
    await expect(clip).toHaveCount(1);
    await page.mouse.move(0, 0);
    const corner = clip.locator("button.fade-corner.in.zero");
    const trimIn = clip.locator(".trim-handle.in");
    const trimOut = clip.locator(".trim-handle.out");
    await expect(trimIn).toHaveCSS("opacity", "0");
    await expect(corner).toHaveCSS("opacity", "0");
    // Forward: Tab from the clip body lands on the zero fade corner, revealed.
    await clip.locator(".clip-hit").focus();
    await page.keyboard.press("Tab");
    await expect(corner).toBeFocused();
    await expect(corner).toHaveCSS("opacity", "1");
    await expect(trimIn).toHaveCSS("opacity", "1");
    // Reverse: leave the clip from its last control, then Shift+Tab back in.
    await trimOut.focus();
    await page.keyboard.press("Tab");
    await expect(trimOut).not.toBeFocused();
    await expect(trimOut).toHaveCSS("opacity", "0");
    await page.keyboard.press("Shift+Tab");
    await expect(trimOut).toBeFocused();
    await expect(trimOut).toHaveCSS("opacity", "1");
    await expectPageAxeClean(page, ".lane-row .clip-block");
  });

  test("keeps the join badge clear of the fade corners and the join diamond", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const lane = page.locator(".lane-row").first();
    const clips = lane.locator(".clip-block");
    await expect(clips).toHaveCount(1);
    // Shift+ArrowRight nudges the playhead 5 s; Mod+K splits the dialogue tracks there.
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(clips).toHaveCount(2);
    try {
      const badge = lane.locator(".join-badge");
      await expect(badge).toHaveCount(1);
      const badgeBox = await badge.boundingBox();
      if (!badgeBox) throw new Error("join badge has no box");
      const diamondBox = await lane.locator(".join-diamond").boundingBox();
      if (!diamondBox) throw new Error("join diamond has no box");
      expect(intersects(badgeBox, diamondBox)).toBe(false);
      // Selecting a clip reveals its zero-length fade corners at the seam.
      await clips.nth(1).click();
      const cornerIn = clips.nth(1).locator("button.fade-corner.in");
      await expect(cornerIn).toHaveCSS("opacity", "1");
      const inBox = await cornerIn.boundingBox();
      if (!inBox) throw new Error("fade-in corner has no box");
      expect(intersects(badgeBox, inBox)).toBe(false);
      await clips.nth(0).click();
      const cornerOut = clips.nth(0).locator("button.fade-corner.out");
      await expect(cornerOut).toHaveCSS("opacity", "1");
      const outBox = await cornerOut.boundingBox();
      if (!outBox) throw new Error("fade-out corner has no box");
      expect(intersects(badgeBox, outBox)).toBe(false);
    } finally {
      // Leave the shared live E2E project as later specs expect it.
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(clips).toHaveCount(1);
    }
  });
});
