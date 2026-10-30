import { expect, test } from "@playwright/test";
import { hit, interrupt, record, runAudit, snapshot } from "./lifecycleAudit";
import { openPanel } from "./stageNav";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
for (const terminal of ["loss", "cancel"] as const)
  test(`F05 existing range restored after native Shift body ${terminal}`, async ({
    page,
  }, info) => {
    await runAudit(page, info, false, async (p, c) => {
      const body = page
        .locator('.lane-row[data-track-id="reference"] .clip-hit')
        .first();
      let point = await hit(body);
      const paint = async (a: number, b: number) => {
        point = await hit(body);
        const start = { x: point.x + a, y: point.y };
        const actual = await body.evaluate(
          (owner, p) => ({
            owned: owner.contains(document.elementFromPoint(p.x, p.y)),
            hit: document.elementFromPoint(p.x, p.y)?.outerHTML,
            rect: owner.getBoundingClientRect().toJSON(),
          }),
          start,
        );
        await record(page, info, `range-hit-${a}`, { start, actual });
        expect(actual.owned).toBe(true);
        await page.keyboard.down("Shift");
        await page.mouse.move(point.x + a, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + b, point.y, { steps: 5 });
      };
      await paint(-150, -60);
      await page.mouse.up();
      await page.keyboard.up("Shift");
      const overlay = page.locator(".range-overlay");
      await expect(overlay).toBeVisible();
      const rect = () =>
        overlay.evaluate((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, width: r.width };
        });
      const previous = await rect(),
        before = snapshot(p);
      await paint(20, 140);
      await expect.poll(rect).not.toEqual(previous);
      await interrupt(page, body, terminal, point);
      await page.keyboard.up("Shift");
      await expect.poll(rect).toEqual(previous);
      expect(snapshot(p)).toEqual(before);
      expect(c).toEqual([]);
      await record(page, info, "range-previous-restored", {
        previous,
        restored: await rect(),
        syntheticCancel: terminal === "cancel",
        captureLossScript: terminal === "loss",
      });
    });
  });
test("F06 wrapped passage reversal and the Mute verb on words ignores them and Undo takes it back", async ({
  page,
}, info) => {
  await runAudit(page, info, false, async (p, c) => {
    await page.setViewportSize({ width: 820, height: 1024 });
    await openPanel(page, "transcript");
    await expect(page.locator(".sys-script-word").first()).toBeVisible();
    const words = page.locator(
      '.sys-script-body .sys-script-word[data-word-key^="reference:"]',
    );
    const first = words.nth(0),
      last = words.nth(18),
      middle = words.nth(4);
    await first.scrollIntoViewIfNeeded();
    const a = await hit(first),
      b = await hit(last),
      r = await hit(middle),
      before = snapshot(p);
    expect(b.y, "Preparation must span an actual wrapped line").toBeGreaterThan(
      a.y,
    );
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await expect(last).toHaveAttribute("data-selected");
    await page.mouse.move(r.x, r.y, { steps: 6 });
    await expect(middle).toHaveAttribute("data-selected");
    await expect(words.nth(5)).not.toHaveAttribute("data-selected");
    await page.mouse.up();
    expect(snapshot(p)).toEqual(before);
    expect(c).toEqual([]);
    await record(page, info, "passage-reversal", {
      first: a,
      last: b,
      reversed: r,
      wrapped: b.y !== a.y,
    });
    const actions = page.getByRole("group", {
      name: /^(Selection|Edit) actions$/,
    });
    await expect(actions).toBeVisible();
    await actions.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Mute", exact: true }).click();
    await expect
      .poll(() => c.filter((v) => v.type !== "UndoHistory").length)
      .toBe(1);
    // Mute on selected words ignores them (transcript.ignoreWords): the clips
    // keep their geometry, and Undo takes the one command back.
    expect(snapshot(p).clips).toEqual(before.clips);
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(() => c.filter((v) => v.type === "UndoHistory").length)
      .toBe(1);
    expect(snapshot(p).clips).toEqual(before.clips);
  });
});
