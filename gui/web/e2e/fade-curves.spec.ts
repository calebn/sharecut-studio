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
  test("saves each focused keyboard burst once and restores it with one Undo", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    const block = page.locator(".lane-row").first().locator(".clip-block");
    await expect(block).toHaveCount(1);
    const clipId = await block.getAttribute("data-clip-id");
    if (!clipId) throw new Error("clip lacks identity");
    const snapshot = async () => {
      const response = await page.request.get(
        `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
      );
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as {
        clips: {
          tracks: Record<
            string,
            Array<{
              id: string;
              fade_in_ms: number;
              fade_out_ms: number;
              source_start: number;
              source_end: number;
            }>
          >;
        };
      };
      const clip = Object.values(body.clips.tracks)
        .flat()
        .find((row) => row.id === clipId);
      if (!clip) throw new Error("clip missing from saved snapshot");
      return clip;
    };
    const commands: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/document/command")
      )
        commands.push(request.postDataJSON());
    });
    const before = await snapshot();
    const ruler = page.getByRole("slider", { name: "Timeline position" });
    const playhead = Number(await ruler.getAttribute("aria-valuenow"));
    for (const step of [
      {
        selector: ".fade-corner.in",
        key: "ArrowRight",
        shift: false,
        field: "fade_in_ms",
        expected: before.fade_in_ms + 3,
        type: "SetClipFade",
      },
      {
        selector: ".fade-corner.out",
        key: "ArrowLeft",
        shift: true,
        field: "fade_out_ms",
        expected: before.fade_out_ms + 30,
        type: "SetClipFade",
      },
      {
        selector: ".trim-handle.in",
        key: "ArrowRight",
        shift: false,
        field: "source_start",
        expected: before.source_start + 0.03,
        type: "TrimClipEdge",
      },
      {
        selector: ".trim-handle.out",
        key: "ArrowLeft",
        shift: true,
        field: "source_end",
        expected: before.source_end - 0.3,
        type: "TrimClipEdge",
      },
    ] as const) {
      const handle = block.locator(step.selector);
      await handle.focus();
      const count = commands.length;
      if (step.shift) await page.keyboard.down("Shift");
      for (let repeat = 0; repeat < 3; repeat++)
        await page.keyboard.down(step.key);
      expect(commands).toHaveLength(count);
      await expect(ruler).toHaveAttribute("aria-valuenow", String(playhead));
      await page.keyboard.up(step.key);
      if (step.shift) await page.keyboard.up("Shift");
      await expect
        .poll(async () => (await snapshot())[step.field])
        .toBeCloseTo(step.expected, 6);
      const edits = commands
        .slice(count)
        .filter((command) => command.type === step.type);
      expect(edits).toHaveLength(1);
      expect(edits[0].payload.clip_id).toBe(clipId);
      if (step.type === "SetClipFade")
        expect(edits[0].payload).toMatchObject({
          fade_in_ms:
            step.field === "fade_in_ms" ? step.expected : before.fade_in_ms,
          fade_out_ms:
            step.field === "fade_out_ms" ? step.expected : before.fade_out_ms,
        });
      else {
        expect(edits[0].payload.source_sec).toBeCloseTo(step.expected, 6);
        expect(edits[0].payload.expected_token).toEqual(expect.any(String));
      }
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(async () => (await snapshot())[step.field])
        .toBeCloseTo(before[step.field], 6);
      expect(
        commands
          .slice(count)
          .filter((command) => command.type === "UndoHistory"),
      ).toHaveLength(1);
    }
    await block.locator(".clip-hit").focus();
    const commandCount = commands.length;
    await page.keyboard.press("ArrowRight");
    await expect(ruler).toHaveAttribute("aria-valuenow", String(playhead + 1));
    expect(commands).toHaveLength(commandCount);
    await expectPageAxeClean(page, ".lane-row .clip-block");
  });

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

  test("keeps the join badge clear of the fade corners, the roll seam and the marker lane at any root font size", async ({
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

      const expectBadgeClear = async () => {
        const badgeBox = await badge.boundingBox();
        if (!badgeBox) throw new Error("join badge has no box");
        const seamBox = await lane.locator(".join-seam").boundingBox();
        if (!seamBox) throw new Error("roll seam has no box");
        expect(intersects(badgeBox, seamBox)).toBe(false);
        // The first track sits right under the marker lane; the badge must not paint over it.
        const markerBox = await page
          .locator(".marker-lane")
          .first()
          .boundingBox();
        if (!markerBox) throw new Error("marker lane has no box");
        expect(intersects(badgeBox, markerBox)).toBe(false);
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
        // The glyph stays inside the badge (it fills the gutter's content box).
        // Re-read the badge box here: the two clip selects above can scroll the
        // lane (the join badge is now a real button, part of the tab/click
        // order), and the badge's own box would otherwise be stale.
        const glyphBadgeBox = await badge.boundingBox();
        if (!glyphBadgeBox) throw new Error("join badge has no box");
        const glyphBox = await badge.locator(".join-badge-glyph").boundingBox();
        if (!glyphBox) throw new Error("join badge glyph has no box");
        const eps = 0.01;
        expect(glyphBox.x).toBeGreaterThanOrEqual(glyphBadgeBox.x - eps);
        expect(glyphBox.y).toBeGreaterThanOrEqual(glyphBadgeBox.y - eps);
        expect(glyphBox.x + glyphBox.width).toBeLessThanOrEqual(
          glyphBadgeBox.x + glyphBadgeBox.width + eps,
        );
        expect(glyphBox.y + glyphBox.height).toBeLessThanOrEqual(
          glyphBadgeBox.y + glyphBadgeBox.height + eps,
        );
      };

      await expectBadgeClear();
      // A larger browser text size grows rem chrome but not the px clip gutter the badge fills.
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "24px";
      });
      await expectBadgeClear();

      // Two clips with a drawn join badge and the seam clip's revealed zero fade corners.
      await expectPageAxeClean(page, ".lane-row .clip-block");
      await expectPageAxeClean(page, ".lane-row .join-badge");
    } finally {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "";
      });
      // Leave the shared live E2E project as later specs expect it.
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(clips).toHaveCount(1);
    }
  });
});
