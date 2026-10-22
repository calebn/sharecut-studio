import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openPhoneTimeline } from "./phoneTimeline";

const VIEWPORTS = [
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "desktop", width: 1280, height: 800 },
];

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("no box");
  return b;
}
function expectSameBox(a: Box, b: Box, tolerance = 0.01) {
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(a[key] - b[key])).toBeLessThanOrEqual(tolerance);
}
async function blendWidth(blend: Locator): Promise<number> {
  return blend.evaluate((el) =>
    Number.parseFloat((el as SVGElement).style.width),
  );
}
async function visibleSpan(tiles: Locator, waves: Locator) {
  const clip = await box(waves);
  const boxes = [await box(tiles.nth(0)), await box(tiles.nth(1))];
  return {
    left: Math.max(clip.x, Math.min(...boxes.map((b) => b.x))),
    right: Math.min(
      clip.x + clip.width,
      Math.max(...boxes.map((b) => b.x + b.width)),
    ),
  };
}
async function centreOn(page: Page, target: Locator, at = 0.3) {
  const b = await box(target);
  await page.locator(".timeline-scroll").evaluate(
    (el, x) => {
      const r = el.getBoundingClientRect();
      el.scrollLeft += x.centre - (r.left + r.width * x.at);
    },
    { centre: b.x + b.width / 2, at },
  );
  await page.waitForTimeout(150);
}

test.use({ deviceScaleFactor: 2 });

for (const theme of ["dark", "light"])
  for (const vp of VIEWPORTS) {
    test(`crossfade overlap draws two waveforms across the exact overlap at ${vp.name} in the ${theme} theme`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(
        (t) => localStorage.setItem("daw_theme", t),
        theme,
      );
      await page.setViewportSize({ width: 1280, height: 844 });
      await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        /aligned dialogue/i,
      );
      const snapshot = async () =>
        (await (
          await page.request.get(
            `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
          )
        ).json()) as { clips: { tracks: Record<string, unknown[]> } };
      try {
        await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.press("ControlOrMeta+K");
        const lane = page.locator(".lane-row").nth(1);
        await expect(lane.locator(".clip-block")).toHaveCount(2);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        if (vp.width < 600) await openPhoneTimeline(page);
        if (vp.name === "phone-landscape")
          await page.getByRole("button", { name: "Maximize timeline" }).click();
        const badge = lane.locator(".join-badge");
        await badge.click();
        const panel = page.getByRole("dialog", { name: /join at/ });
        await panel
          .getByRole("button", { name: "Crossfade", exact: true })
          .click();
        await expect(badge).toHaveClass(/crossfade/);
        await page.keyboard.press("Escape");

        const blend = lane.locator(".join-blend");
        const seam = lane.locator(".join-blend-seam");
        const waves = lane.locator(".join-blend-waves");
        const tiles = waves.locator("canvas.clip-waveform-tile");
        await expect(blend).toBeAttached();
        const position = page.getByRole("slider", {
          name: "Timeline position",
        });
        await position.focus();
        await page.keyboard.press("Home");
        await centreOn(page, blend);

        const fitWidth = await blendWidth(blend);
        const fitBox = await box(blend);
        if (fitWidth < 1) {
          await expect(seam).toHaveCount(1);
          await expect(tiles).toHaveCount(0);
          const exact = Number(await seam.getAttribute("data-exact-px"));
          expect(Math.abs(exact - fitWidth)).toBeLessThan(1e-6);
          const hair = await box(seam);
          const dpr = await page.evaluate(() => window.devicePixelRatio);
          expect(Math.abs(hair.width - 1 / dpr)).toBeLessThanOrEqual(0.01);
          expect(
            Math.abs(hair.x + hair.width / 2 - (fitBox.x + fitBox.width / 2)),
          ).toBeLessThanOrEqual(0.5);
          expect(
            await seam.evaluate((el) => getComputedStyle(el).pointerEvents),
          ).toBe("none");
          expect(await seam.locator("> span").count()).toBe(2);
          expectSameBox(await box(blend), fitBox);
        }

        await position.focus();
        let mid = false;
        for (let i = 0; i < 60 && (await blendWidth(blend)) < 6; i++) {
          await page.keyboard.press("+");
          const w = await blendWidth(blend);
          if (!mid && w >= 2.5 && w < 6) {
            mid = true;
            await centreOn(page, blend);
            await position.focus();
          }
        }
        expect(mid).toBe(true);
        expect(await blendWidth(blend)).toBeGreaterThanOrEqual(6);
        await centreOn(page, blend);
        await expect(seam).toHaveCount(0);

        const badgeBefore = await box(badge);
        await expect(tiles).toHaveCount(2);
        const blendBox = await box(blend);
        expectSameBox(await box(waves), blendBox, 0.5);
        const shown = await visibleSpan(tiles, waves);
        expect(Math.abs(shown.left - blendBox.x)).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(shown.right - (blendBox.x + blendBox.width)),
        ).toBeLessThanOrEqual(0.5);
        expectSameBox(await box(badge), badgeBefore);
        expect(
          await waves.evaluate((el) => getComputedStyle(el).pointerEvents),
        ).toBe("none");
        const centre = {
          x: badgeBefore.x + badgeBefore.width / 2,
          y: badgeBefore.y + badgeBefore.height / 2,
        };
        expect(
          await page.evaluate(
            ({ x, y }) =>
              document.elementFromPoint(x, y)?.closest(".join-badge") != null,
            centre,
          ),
        ).toBe(true);

        await badge.click();
        const grip = page.getByRole("button", {
          name: /Drag crossfade right endpoint/,
        });
        await expect(grip).toBeEnabled();
        const gripBefore = await box(grip);
        const widthBefore = await blendWidth(blend);
        expectSameBox(await box(badge), badgeBefore, 0.5);
        const badgeWith = await box(badge);
        const hide = await page.addStyleTag({
          content: ".join-blend-waves{display:none !important}",
        });
        await page.waitForTimeout(100);
        expectSameBox(await box(grip), gripBefore);
        expectSameBox(await box(badge), badgeWith);
        await hide.evaluate((el) => (el as Element).remove());
        await page.waitForTimeout(100);
        expectSameBox(await box(grip), gripBefore);
        expectSameBox(await box(badge), badgeWith);
        const grab = await page.evaluate(({ x, y, width, height }) => {
          for (let dy = 0.5; dy < 1; dy += 0.1)
            for (let dx = 0.5; dx < 1; dx += 0.1) {
              const px = x + width * dx,
                py = y + height * dy;
              if (
                document.elementFromPoint(px, py)?.closest(".join-length-grip")
              )
                return { x: px, y: py };
            }
          return null;
        }, gripBefore);
        if (!grab) throw new Error("grip is not hit-testable");
        await page.mouse.move(grab.x, grab.y);
        await page.mouse.down();
        await page.mouse.move(grab.x + 30, grab.y, { steps: 4 });
        await expect.poll(() => blendWidth(blend)).toBeGreaterThan(widthBefore);
        const grown = await box(blend);
        expect(grown.width).toBeGreaterThan(blendBox.width);
        await expect(tiles).toHaveCount(2);
        const draft = await visibleSpan(tiles, waves);
        expect(Math.abs(draft.left - grown.x)).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(draft.right - (grown.x + grown.width)),
        ).toBeLessThanOrEqual(0.5);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await position.focus();
        for (let i = 0; i < 20 && (await blendWidth(blend)) < 40; i++)
          await page.keyboard.press("+");
        await centreOn(page, blend);
        await expect(tiles).toHaveCount(2);
      } finally {
        await page.keyboard.press("Escape");
        await page.evaluate(() =>
          (document.activeElement as HTMLElement)?.blur(),
        );
        for (let i = 0; i < 8; i++) {
          const rows = Object.values((await snapshot()).clips.tracks);
          if (rows.every((r) => r.length === 1)) break;
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
