import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

interface Clip {
  id: string;
  fade_in_ms: number;
  fade_out_ms: number;
  timeline_start: number;
  timeline_end: number;
  source_start: number;
  source_end: number;
  join_in_mode: string;
  join_crossfade_ms: number;
  source_id: string | null;
}
async function snapshot(page: Page) {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    clips: { tracks: Record<string, Clip[]> };
  };
}
function placement(row: Clip) {
  return [
    row.source_id,
    row.source_start,
    row.source_end,
    row.timeline_start,
    row.timeline_end,
  ];
}
for (const width of [1280, 390]) {
  test(`coupled crossfade length persists and undoes at ${width}`, async ({
    page,
  }, testInfo) => {
    if (width === 390) await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    try {
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("ControlOrMeta+K");
      const lane = page.locator(".lane-row").first();
      await expect(lane.locator(".clip-block")).toHaveCount(2);
      if (width === 390) {
        await page.setViewportSize({ width, height: 844 });
        await page
          .getByRole("button", { name: "Timeline", exact: true })
          .click();
      }
      const badge = lane.locator(".join-badge");
      await badge.click();
      const panel = page.getByRole("dialog", { name: /join at/ });
      await panel
        .getByRole("button", { name: "Crossfade", exact: true })
        .click();
      await expect(badge).toHaveClass(/crossfade/);
      const initial = await snapshot(page);
      const trackId = await lane.getAttribute("data-track-id");
      if (!trackId) throw new Error("missing lane track");
      const pair = initial.clips.tracks[trackId]!;
      const [left, right] = pair;
      if (!left || !right) throw new Error("missing pair");
      const commands: Array<{
        type: string;
        payload: Record<string, unknown>;
      }> = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().includes("/api/document/command"))
          commands.push(r.postDataJSON());
      });
      const grip = page.getByRole("button", {
        name: /Drag crossfade right endpoint/,
      });
      await expect(grip).toBeVisible();
      await expect(grip).toBeEnabled();
      const g = (await grip.boundingBox())!,
        rail = (await page.locator(".join-edit-rail").boundingBox())!,
        p = (await panel.boundingBox())!;
      expect(g.width).toBeGreaterThanOrEqual(44);
      expect(g.height).toBeGreaterThanOrEqual(44);
      expect(p.y + p.height).toBeLessThanOrEqual(rail.y);
      const caption = (await page.locator(".join-edit-caption").boundingBox())!;
      expect(caption.y + caption.height).toBeLessThanOrEqual(g.y);
      for (const dx of [2, g.width / 2, g.width - 2])
        expect(
          await page.evaluate(
            ([x, y]) =>
              document.elementFromPoint(x, y)?.closest(".join-length-grip") !=
              null,
            [g.x + dx, g.y + g.height / 2],
          ),
        ).toBe(true);
      const paint = lane.locator(".join-blend");
      const verifyPaint = async () => {
        const r = (await paint.boundingBox())!,
          b = (await badge.boundingBox())!;
        const values = await paint.evaluate((el) => ({
          left: Number.parseFloat((el as SVGElement).style.left),
          width: Number.parseFloat((el as SVGElement).style.width),
        }));
        expect(Math.abs(r.width - values.width)).toBeLessThanOrEqual(1 / 32);
        expect(
          Math.abs(r.x + r.width / 2 - b.x - b.width / 2),
        ).toBeLessThanOrEqual(1 / 32);
      };
      await verifyPaint();
      const firstWidth = await paint.evaluate((el) =>
        Number.parseFloat((el as SVGElement).style.width),
      );
      await page.keyboard.press("Escape");
      await page.getByRole("slider", { name: "Timeline position" }).focus();
      await page.keyboard.press("+");
      await badge.click();
      await verifyPaint();
      expect(
        await paint.evaluate((el) =>
          Number.parseFloat((el as SVGElement).style.width),
        ),
      ).toBeGreaterThan(firstWidth);
      const movedGrip = (await grip.boundingBox())!;
      await testInfo.attach("rail-geometry.json", {
        body: JSON.stringify({
          width,
          grip: movedGrip,
          rail,
          popover: p,
          caption,
        }),
        contentType: "application/json",
      });
      await page.screenshot({
        path: testInfo.outputPath(`crossfade-rail-${width}.png`),
      });
      const blockBox = (await lane
        .locator(".clip-block")
        .first()
        .boundingBox())!;
      expect(
        await page.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x, y)?.closest(".clip-hit") != null,
          [
            Math.min(
              width - 24,
              Math.max(
                blockBox.x + 24,
                (await panel.boundingBox())!.x +
                  (await panel.boundingBox())!.width +
                  24,
              ),
            ),
            blockBox.y + blockBox.height / 2,
          ],
        ),
      ).toBe(true);
      const x = movedGrip.x + movedGrip.width / 2,
        y = movedGrip.y + movedGrip.height / 2;
      if (width === 390) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        // The touch grammar: a long press arms the grip before it drags.
        await page.waitForTimeout(750);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x - 8, y }],
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 8, y);
        await expect(page.locator(".join-edit-caption")).toContainText(
          "Draft overlap 1 ms",
        );
        await page.mouse.up();
      }
      await expect
        .poll(async () => {
          const s = await snapshot(page);
          return Object.values(s.clips.tracks)
            .flat()
            .find((c) => c.id === right.id)?.fade_in_ms;
        })
        .toBe(1);
      expect(commands.filter((c) => c.type === "SetClipJoin")).toHaveLength(1);
      const changed = Object.values((await snapshot(page)).clips.tracks).flat();
      expect(changed.find((c) => c.id === left.id)?.fade_out_ms).toBe(1);
      expect(placement(changed.find((c) => c.id === left.id)!)).toEqual(
        placement(left),
      );
      expect(placement(changed.find((c) => c.id === right.id)!)).toEqual(
        placement(right),
      );
      await verifyPaint();
      await page.reload();
      if (width === 390)
        await page
          .getByRole("button", { name: "Timeline", exact: true })
          .click();
      await badge.click();
      await expect(grip).toBeVisible();
      await expect(grip).toBeEnabled();
      await expect(panel.getByRole("slider", { name: "Length" })).toHaveValue(
        "1",
      );
      const range = panel.getByRole("slider", { name: "Length" });
      await range.focus();
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(
          async () =>
            Object.values((await snapshot(page)).clips.tracks)
              .flat()
              .find((c) => c.id === right.id)?.fade_in_ms,
        )
        .toBe(2);
      expect(commands.filter((c) => c.type === "SetClipJoin")).toHaveLength(2);
      await expectPageAxeClean(page, ".join-popover");
      await expectPageAxeClean(page, ".join-edit-rail");
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+Z");
      const savedPair = async () => {
        const rows = Object.values((await snapshot(page)).clips.tracks).flat();
        const l = rows.find((c) => c.id === left.id)!,
          r = rows.find((c) => c.id === right.id)!;
        return [l.fade_out_ms, r.fade_in_ms, r.fade_out_ms, r.join_in_mode];
      };
      await expect
        .poll(savedPair)
        .toEqual([1, 1, right.fade_out_ms, "crossfade"]);
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(savedPair)
        .toEqual([
          left.fade_out_ms,
          right.fade_in_ms,
          right.fade_out_ms,
          right.join_in_mode,
        ]);
      await page.reload();
      if (width === 390)
        await page
          .getByRole("button", { name: "Timeline", exact: true })
          .click();
      await expect(lane.locator(".join-blend")).toBeVisible();
      await badge.click();
      const again = (await grip.boundingBox())!;
      await page.mouse.move(
        again.x + again.width / 2,
        again.y + again.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        again.x + again.width / 2 + 8,
        again.y + again.height / 2,
      );
      await page.keyboard.press("Escape");
      await page.mouse.up();
      expect(commands.filter((c) => c.type === "SetClipJoin")).toHaveLength(2);
      await badge.click();
      await expect(grip).toBeEnabled();
      await page.route("**/api/document/command?*", async (route) => {
        if (route.request().postDataJSON().type === "SetClipJoin")
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Rejected join length" }),
          });
        else await route.continue();
      });
      const failGrip = (await grip.boundingBox())!;
      await page.mouse.move(
        failGrip.x + failGrip.width / 2,
        failGrip.y + failGrip.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        failGrip.x + failGrip.width / 2 - 8,
        failGrip.y + failGrip.height / 2,
      );
      await page.mouse.up();
      await expect(panel.getByRole("alert")).toContainText(
        "Rejected join length",
      );
      await expect
        .poll(savedPair)
        .toEqual([
          left.fade_out_ms,
          right.fade_in_ms,
          right.fade_out_ms,
          right.join_in_mode,
        ]);
      await page.unroute("**/api/document/command?*");
      await page.screenshot({
        path: testInfo.outputPath(`crossfade-${width}.png`),
      });
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+Z");
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(lane.locator(".clip-block")).toHaveCount(1);
    } finally {
      await page.keyboard.press("Escape");
      await page.evaluate(() =>
        (document.activeElement as HTMLElement)?.blur(),
      );
      for (let i = 0; i < 8; i++) {
        if (
          Object.values((await snapshot(page)).clips.tracks).every(
            (rows) => rows.length === 1,
          )
        )
          break;
        const done = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            r.url().includes("/api/document/command"),
        );
        await page.keyboard.press("ControlOrMeta+Z");
        await done;
      }
    }
  });
}
