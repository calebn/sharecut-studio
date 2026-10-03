import { expect, test } from "@playwright/test";
import {
  begin,
  draw,
  hit,
  interrupt,
  layer,
  read,
  record,
  runAudit,
  snapshot,
} from "./lifecycleAudit";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test("F01 native off-center cross-track move preserves source and Undo", async ({
  page,
}, info) => {
  await runAudit(page, info, true, async (p, c) => {
    const block = page.locator(
        '[data-testid="timeline-clip"][data-clip-id="lifecycle-move"]',
      ),
      body = block.locator(".clip-hit"),
      before = snapshot(p);
    const start = await hit(body, "offcenter");
    const lane = page.locator('.lane-row[data-track-id="guest"]');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const target = await draw(lane);
    await page.mouse.move(start.x + 24, target.y + target.height / 2, {
      steps: 8,
    });
    await expect(
      page.locator(
        '[data-testid="timeline-move-ghost"][data-clip-id="lifecycle-move"]',
      ),
    ).toHaveCount(1);
    expect(snapshot(p)).toEqual(before);
    await record(page, info, "cross-track-preview", {
      before,
      ghost: await draw(
        page.locator(
          '[data-testid="timeline-move-ghost"][data-clip-id="lifecycle-move"]',
        ),
      ),
    });
    await page.mouse.up();
    await expect
      .poll(() => c.filter((v) => v.type === "MoveClips").length)
      .toBe(1);
    await expect
      .poll(
        () =>
          read(p).timeline.clips.find((v) => v.id === "lifecycle-move")!
            .track_id,
      )
      .toBe("guest");
    const after = read(p).timeline.clips.find(
      (v) => v.id === "lifecycle-move",
    )!;
    expect(after.source_start).toBe(0);
    expect(after.source_end).toBe(10);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => snapshot(p).clips).toEqual(before.clips);
  });
});
for (const terminal of ["loss", "cancel"] as const)
  test(`F01 native clip owner ${terminal} restores geometry with inert later release`, async ({
    page,
  }, info) => {
    await runAudit(page, info, true, async (p, c) => {
      const block = page.locator(
          '[data-testid="timeline-clip"][data-clip-id="lifecycle-move"]',
        ),
        body = block.locator(".clip-hit"),
        before = snapshot(p);
      const point = await hit(body);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const origin = await draw(block);
      await page.mouse.move(point.x + 24, point.y, { steps: 4 });
      await expect.poll(async () => (await draw(block)).x).not.toBe(origin.x);
      await interrupt(page, body, terminal, point);
      await expect.poll(() => draw(block)).toEqual(origin);
      expect(snapshot(p)).toEqual(before);
      expect(c.filter((v) => v.type === "MoveClips")).toEqual([]);
      await body.click();
      await expect(body).toHaveAttribute("aria-pressed", "true");
    });
  });
for (const kind of ["chapter", "social"] as const)
  for (const terminal of ["escape", "loss", "cancel", "unmount"] as const)
    test(`F10 ${kind} ${terminal} leaves exact saved origin and no mutation`, async ({
      page,
    }, info) => {
      await runAudit(page, info, false, async (p, c) => {
        const target = page.getByRole("button", {
          name:
            kind === "chapter"
              ? "Chapter Lifecycle chapter"
              : "Lifecycle social",
          exact: true,
        });
        const before = snapshot(p),
          origin = await draw(target),
          point = await begin(page, target, 20);
        await expect
          .poll(async () => (await draw(target)).x)
          .not.toBe(origin.x);
        if (terminal === "unmount") {
          await layer(page, "Markers", false);
          await page.mouse.move(point.x + 32, point.y);
          await page.mouse.up();
          await layer(page, "Markers", true);
        } else await interrupt(page, target, terminal, point, false);
        await expect.poll(() => draw(target)).toEqual(origin);
        await page.mouse.up();
        expect(snapshot(p)).toEqual(before);
        expect(
          c.filter(
            (v) =>
              v.type ===
              (kind === "chapter" ? "UpdateChapter" : "UpdateSocialClip"),
          ),
        ).toEqual([]);
      });
    });
for (const edge of ["start", "end"] as const)
  test(`F10 native social ${edge} edge preserves opposite bound and Undo`, async ({
    page,
  }, info) => {
    await runAudit(page, info, false, async (p, c) => {
      const target = page.getByRole("button", {
          name: "Lifecycle social",
          exact: true,
        }),
        before = snapshot(p);
      await begin(page, target, edge === "start" ? 14 : -14, edge);
      expect(snapshot(p)).toEqual(before);
      const preview = await draw(target);
      await record(page, info, `social-${edge}-preview`, { preview, before });
      await page.mouse.up();
      await expect
        .poll(() => c.filter((v) => v.type === "UpdateSocialClip").length)
        .toBe(1);
      await expect.poll(() => snapshot(p).social).not.toEqual(before.social);
      const after = snapshot(p).social[0];
      expect(edge === "start" ? after.end : after.start).toBe(
        edge === "start" ? 24 : 18,
      );
      expect(after.end).toBeGreaterThan(after.start);
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => snapshot(p).social).toEqual(before.social);
    });
  });
