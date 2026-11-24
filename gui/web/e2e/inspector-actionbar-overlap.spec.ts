import { expect, type Locator, type Page, test } from "@playwright/test";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { createScriptRecordingIdentityProject } from "./scriptRecordingIdentityProject";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";

test.use({ hasTouch: true, reducedMotion: "reduce" });

async function overlapArea(a: Locator, b: Locator) {
  const [first, second] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (!first || !second) return null;
  const width =
    Math.min(first.x + first.width, second.x + second.width) -
    Math.max(first.x, second.x);
  const height =
    Math.min(first.y + first.height, second.y + second.height) -
    Math.max(first.y, second.y);
  return Math.max(0, width) * Math.max(0, height);
}

const clipPositions = [
  { clip: "left", at: 0.1 },
  { clip: "right", at: 0.5 },
  { clip: "other", at: 0.9 },
] as const;

async function inspectClipAt(
  page: Page,
  touch: boolean,
  { clip: id, at }: (typeof clipPositions)[number],
) {
  const clip = page.locator(`[data-clip-id="${id}"] .clip-hit`);
  for (let i = 0; i < 4; i++) await page.keyboard.press("=");
  await clip.press("Enter");
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  await page.locator(".timeline-scroll").evaluate(
    (scroller, [clipId, fraction]) => {
      const hit = scroller.querySelector(
        `[data-clip-id="${clipId}"] .clip-hit`,
      );
      if (!hit) throw new Error(`no clip ${clipId}`);
      const box = hit.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      scroller.scrollLeft +=
        box.left + box.width / 2 - view.left - fraction * view.width;
    },
    [id, at] as const,
  );
  const inspect = page.getByRole("button", { name: "Inspect", exact: true });
  if (touch) await inspect.tap();
  else await inspect.click();
}

const layouts = [
  { width: 844, height: 530, touch: true, corner: true },
  { width: 812, height: 375, touch: true, corner: false },
  { width: 932, height: 430, touch: true, corner: false },
  { width: 1024, height: 600, touch: true, corner: true },
  { width: 820, height: 1180, touch: true, corner: true },
  { width: 844, height: 530, touch: false, corner: true },
] as const;

for (const { width, height, touch, corner: hasCorner } of layouts) {
  for (const position of clipPositions) {
    test(`${width}x${height}${touch ? "" : " with a mouse"}, clip ${position.clip} centered at ${position.at} of the frame: the Action bar, the Inspector and Timeline view stay apart`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: touch,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      try {
        await withShareableProject(
          async (projectPath) => {
            await openProject(page, projectPath);
            await inspectClipAt(page, touch, position);
            const card = page.getByRole("dialog", {
              name: "Inspector",
              exact: true,
            });
            const bar = page.getByRole("group", { name: "Selection actions" });
            const corner = page.getByRole("group", { name: "Timeline view" });
            await expect(card).toBeVisible();
            await expect(bar).toBeVisible();
            if (hasCorner) await expect(corner).toBeVisible();
            else await expect(corner).toBeHidden();
            const pairs = [
              ["bar x card", bar, card],
              ...(hasCorner
                ? ([
                    ["bar x corner", bar, corner],
                    ["card x corner", card, corner],
                  ] as const)
                : []),
            ] as const;
            for (const [name, first, second] of pairs) {
              await expect
                .poll(() => overlapArea(first, second), {
                  message: `${name} overlap in CSS square pixels`,
                })
                .toBe(0);
              test.info().annotations.push({
                type: `${name} overlap px2`,
                description: String(await overlapArea(first, second)),
              });
            }
            test.info().annotations.push({
              type: "bar box",
              description: JSON.stringify(await bar.boundingBox()),
            });
          },
          undefined,
          createScriptRecordingIdentityProject,
        );
      } finally {
        await context.close();
      }
    });
  }
}

const pendingLayouts = [
  { width: 844, height: 530, corner: true },
  { width: 932, height: 430, corner: false },
  { width: 820, height: 1180, corner: true },
  { width: 812, height: 375, corner: false },
  { width: 1024, height: 600, corner: true },
] as const;

async function centerHit(target: Locator, inside: Locator) {
  const box = await target.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return inside.evaluate(
    (el, [px, py]) => el.contains(document.elementFromPoint(px, py)),
    [x, y] as const,
  );
}

for (const { width, height, corner: hasCorner } of pendingLayouts) {
  for (const touch of [true, false]) {
    test(`${width}x${height}${touch ? "" : " with a mouse"}, pending edit: the review bar, the Inspector and Timeline view stay apart`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: touch,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      try {
        await withShareableProject(async (projectPath) => {
          await openSuggestedPendingEdit(page, projectPath);
          const card = page.getByRole("dialog", {
            name: "Inspector",
            exact: true,
          });
          const bar = page.getByRole("region", {
            name: "Pending edit actions",
          });
          const strip = page.getByRole("group", { name: "Selection actions" });
          const corner = page.getByRole("group", { name: "Timeline view" });
          await expect(card).toBeVisible();
          await expect(bar).toBeVisible();
          await expect(bar).toHaveAttribute("data-placement", "placed");
          await expect(strip).toBeVisible();
          if (hasCorner) await expect(corner).toBeVisible();
          else await expect(corner).toBeHidden();
          const pairs = [
            ["bar x card", bar, card],
            ["Selection actions x card", strip, card],
            ...(hasCorner
              ? ([
                  ["bar x corner", bar, corner],
                  ["card x corner", card, corner],
                ] as const)
              : []),
          ] as const;
          for (const [name, first, second] of pairs) {
            await expect
              .poll(() => overlapArea(first, second), {
                message: `${name} overlap in CSS square pixels`,
              })
              .toBe(0);
            test.info().annotations.push({
              type: `${name} overlap px2`,
              description: String(await overlapArea(first, second)),
            });
          }
          test.info().annotations.push({
            type: "bar x Selection actions overlap px2",
            description: String(await overlapArea(bar, strip)),
          });
          test.info().annotations.push({
            type: "boxes",
            description: JSON.stringify({
              bar: await bar.boundingBox(),
              card: await card.boundingBox(),
              strip: await strip.boundingBox(),
            }),
          });
          expect(
            await centerHit(card.getByRole("button", { name: "Close" }), card),
            "the card's Close button is the topmost thing at its center",
          ).toBe(true);
          const approve = bar.locator(".pending-actions button").first();
          expect(
            await centerHit(approve, approve),
            "the review bar's first action is the topmost thing at its center",
          ).toBe(true);
        });
      } finally {
        await context.close();
      }
    });
  }
}
