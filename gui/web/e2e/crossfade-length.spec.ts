import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import {
  type CommandAttempt,
  logicalClipJoinCommands,
} from "./clipJoinCommands";
import { e2eProjectPath } from "./env";
import { inspectSelection, openProject, phone } from "./stageNav";

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
const blurFocus = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

for (const width of [1280, 390]) {
  test(`coupled crossfade length persists and undoes at ${width}`, async ({
    page,
  }, testInfo) => {
    if (width === 390) await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 844 });
    await openProject(page, e2eProjectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const commands: CommandAttempt[] = [];
    let primaryFailure: { error: unknown } | null = null;
    const captureFailures: unknown[] = [];
    const cleanupFailures: unknown[] = [];
    try {
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("ControlOrMeta+K");
      const lane = page.locator(".lane-row").first();
      await expect(lane.locator(".clip-block")).toHaveCount(2);
      if (width === 390) {
        await page.setViewportSize({ width, height: 844 });
        await phone.showTimeline(page);
      }
      const badge = lane.locator(".seam-mark .sys-seam-hit");
      await badge.click();
      const joinType = page
        .getByRole("group", { name: /^(Selection|Edit) actions$/ })
        .getByRole("group", { name: "Join type" });
      await joinType.getByRole("button", { name: "Crossfade" }).click();
      await expect(badge).toHaveAccessibleName(/Crossfade join/);
      await expect(badge).toHaveAttribute("aria-pressed", "true");
      const initial = await snapshot(page);
      const trackId = await lane.getAttribute("data-track-id");
      if (!trackId) throw new Error("missing lane track");
      const pair = initial.clips.tracks[trackId]!;
      const [left, right] = pair;
      if (!left || !right) throw new Error("missing pair");
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().includes("/api/document/command"))
          commands.push(r.postDataJSON());
      });
      await inspectSelection(page);
      const length = page.getByRole("spinbutton", { name: "Length" });
      await expect(length).toBeVisible();
      const paint = lane.locator(".join-blend");
      const verifyPaint = async () => {
        const r = (await paint.boundingBox())!,
          b = (await badge.boundingBox())!;
        const values = await paint.evaluate((el) => ({
          width: Number.parseFloat((el as SVGElement).style.width),
        }));
        expect(Math.abs(r.width - values.width)).toBeLessThanOrEqual(1 / 32);
        expect(
          Math.abs(r.x + r.width / 2 - b.x - b.width / 2),
        ).toBeLessThanOrEqual(1 / 32);
      };
      await verifyPaint();
      await length.focus();
      await page.keyboard.press("Home");
      await expect
        .poll(async () => {
          const s = await snapshot(page);
          return Object.values(s.clips.tracks)
            .flat()
            .find((c) => c.id === right.id)?.fade_in_ms;
        })
        .toBe(1);
      expect(logicalClipJoinCommands(commands)).toHaveLength(1);
      await expect(badge).toHaveAttribute("aria-pressed", "true");
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
      if (width === 390) await phone.showTimeline(page);
      await badge.click();
      await inspectSelection(page);
      await expect(length).toHaveAttribute("aria-valuenow", "1");
      await length.focus();
      await page.keyboard.press("ArrowUp");
      await expect
        .poll(
          async () =>
            Object.values((await snapshot(page)).clips.tracks)
              .flat()
              .find((c) => c.id === right.id)?.fade_in_ms,
        )
        .toBe(2);
      expect(logicalClipJoinCommands(commands)).toHaveLength(2);
      await expectPageAxeClean(page, ".sys-inspector");
      const savedPair = async () => {
        const rows = Object.values((await snapshot(page)).clips.tracks).flat();
        const l = rows.find((c) => c.id === left.id)!,
          r = rows.find((c) => c.id === right.id)!;
        return [l.fade_out_ms, r.fade_in_ms, r.fade_out_ms, r.join_in_mode];
      };
      await blurFocus(page);
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(savedPair)
        .toEqual([1, 1, right.fade_out_ms, "crossfade"]);
      await expect(length).toHaveAttribute("aria-valuenow", "1");
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
      if (width === 390) await phone.showTimeline(page);
      await badge.click();
      await joinType.getByRole("button", { name: "Crossfade" }).click();
      await inspectSelection(page);
      await page.route("**/api/document/command?*", async (route) => {
        if (route.request().postDataJSON().type === "SetClipJoin")
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Rejected join length" }),
          });
        else await route.continue();
      });
      await length.focus();
      await page.keyboard.press("ArrowUp");
      await expect(page.getByRole("alert")).toContainText(
        "Rejected join length",
      );
      await page.unroute("**/api/document/command?*");
      await page.screenshot({
        path: testInfo.outputPath(`crossfade-${width}.png`),
      });
      await blurFocus(page);
      await page.keyboard.press("ControlOrMeta+Z");
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(lane.locator(".clip-block")).toHaveCount(1);
    } catch (error) {
      primaryFailure = { error };
    } finally {
      try {
        await testInfo.attach("raw-document-command-attempts-before-cleanup", {
          body: Buffer.from(JSON.stringify(commands)),
          contentType: "application/json",
        });
      } catch (error) {
        captureFailures.push(error);
      }
      try {
        await page.keyboard.press("Escape");
        await blurFocus(page);
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
      } catch (error) {
        cleanupFailures.push(error);
      }
      for (const [type, failures] of [
        ["capture-error", captureFailures],
        ["cleanup-error", cleanupFailures],
      ] as const) {
        for (const error of failures)
          testInfo.annotations.push({
            type,
            description:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
      }
    }
    if (primaryFailure) throw primaryFailure.error;
    if (captureFailures.length || cleanupFailures.length)
      throw new AggregateError(
        [...captureFailures, ...cleanupFailures],
        "Crossfade evidence or cleanup failed",
      );
  });
}
