import { expect, type Page, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import { armRange, openProject, phone } from "./stageNav";

/**
 * Coach tips (G2 part 1) driven through the built app: the Script handles tip
 * and the Undo tip on a phone, nothing on a fine pointer, and the range tip on
 * a tablet but not a phone. Set COACH_SHOTS to a folder to save screenshots.
 */
const SEEN = (id: string) => `sharecut.coachTipSeen.${id}`;
const shotDir = process.env.COACH_SHOTS;

/** Resolves once the page has painted a few frames after the last change. */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );

async function shot(page: Page, name: string) {
  if (!shotDir) return;
  await settled(page);
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

const tip = (page: Page, text: string) =>
  page.locator(".sys-coach-tip", { hasText: text });
const seen = (page: Page, id: string) =>
  page.evaluate((k) => localStorage.getItem(k), SEEN(id));

async function tapWord(page: Page) {
  const word = page
    .locator(".sys-script-body")
    .getByRole("button", { name: /^my(?: \(.*\))?$/ })
    .first();
  await word.scrollIntoViewIfNeeded();
  const box = (await word.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** Visible controls that the tip's box lies over, outside the tip itself. */
async function coveredControls(page: Page, text: string) {
  return page.evaluate((needle) => {
    const t = [
      ...document.querySelectorAll<HTMLElement>(".sys-coach-tip"),
    ].find((n) => n.textContent?.includes(needle));
    if (!t) return ["no tip"];
    const r = t.getBoundingClientRect();
    const hits: string[] = [];
    const sel = "button, a, input, [role=tab], [role=slider], [role=button]";
    for (const c of document.querySelectorAll<HTMLElement>(sel)) {
      if (t.contains(c) || c.contains(t)) continue;
      // Lane and Script content may sit under a tip; header and toggles may not.
      if (c.closest(".sys-script-body, .timeline-area")) continue;
      const b = c.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const cs = getComputedStyle(c);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const overlap =
        Math.min(r.right, b.right) - Math.max(r.left, b.left) > 1 &&
        Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 1;
      if (!overlap) continue;
      // Only count it when the tip is what a finger would hit there.
      const px = Math.max(b.left, r.left) + 2;
      const py = Math.max(b.top, r.top) + 2;
      if (t.contains(document.elementFromPoint(px, py))) {
        hits.push(
          c.getAttribute("aria-label") || c.textContent?.trim() || c.tagName,
        );
      }
    }
    return hits;
  }, text);
}

const phones = [
  { name: "390x844", width: 390, height: 844, root: 16 },
  { name: "360x780", width: 360, height: 780, root: 16 },
  { name: "844x390", width: 844, height: 390, root: 16 },
  { name: "390x844-200pct", width: 390, height: 844, root: 32 },
  { name: "360x780-200pct", width: 360, height: 780, root: 32 },
];

for (const cell of phones) {
  test.describe(`phone ${cell.name}`, () => {
    test.use({
      viewport: { width: cell.width, height: cell.height },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    const landscape = cell.width > cell.height;

    test("handles tip shows once beside the end grip, goes on the next press, stays gone after reload", async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        await openProject(page, projectPath);
        await phone.showText(page);
        if (cell.root !== 16) {
          await page.evaluate((px) => {
            document.documentElement.style.fontSize = `${px}px`;
          }, cell.root);
        }
        await tapWord(page);
        const t = tip(page, "Drag the handles to adjust");
        await expect(t).toBeVisible();
        await shot(page, `handles-tip-${cell.name}`);
        const box = (await t.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(cell.width);
        expect(box.y + box.height).toBeLessThanOrEqual(cell.height);
        const top = await page.evaluate(
          ([x, y]) =>
            document.elementFromPoint(x, y)?.closest(".sys-coach-tip") !== null,
          [box.x + 20, box.y + 20],
        );
        expect(top).toBe(true);
        await page.touchscreen.tap(cell.width / 2, 8);
        await expect(t).toHaveCount(0);
        expect(await seen(page, "selectionHandles")).toBe("1");
        await tapWord(page);
        await expect(t).toHaveCount(0);
        await page.reload();
        await phone.showText(page);
        await tapWord(page);
        await expect(
          page.locator(".sys-script-word[data-selected]").first(),
        ).toBeVisible();
        await expect(t).toHaveCount(0);
      });
    });

    test("first undoable edit shows the undo tip clear of the header controls", async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        await openProject(page, projectPath);
        await phone.showText(page);
        if (cell.root !== 16) {
          await page.evaluate((px) => {
            document.documentElement.style.fontSize = `${px}px`;
          }, cell.root);
        }
        await tapWord(page);
        await expect(tip(page, "Drag the handles to adjust")).toBeVisible();
        // At 200% text the selection action bar is not drawn, so cut by key there.
        const cut = page.getByRole("button", { name: /^Cut\b/ });
        if (await cut.first().isVisible()) await cut.first().tap();
        else await page.keyboard.press("Delete");
        const t = tip(page, "Two-finger tap to undo");
        if (landscape) {
          // 844 px wide is the tablet shell: no two-finger undo, so no tip.
          await expect(page.locator(".ui-toast-message")).toBeVisible();
          await settled(page);
          await expect(t).toHaveCount(0);
          await shot(page, `undo-no-tip-${cell.name}`);
          return;
        }
        await expect(t).toBeVisible();
        await shot(page, `undo-tip-${cell.name}`);
        const box = (await t.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(cell.width);
        expect(box.y + box.height).toBeLessThanOrEqual(cell.height);
        expect(await coveredControls(page, "Two-finger tap to undo")).toEqual(
          [],
        );
        for (const name of ["Timeline", "Script"]) {
          const sw = page
            .getByRole("group", { name: "Edit surface" })
            .getByRole("button", { name, exact: true });
          if (await sw.isVisible()) {
            const b = (await sw.boundingBox())!;
            const hit = await page.evaluate(
              ([x, y]) =>
                !!document.elementFromPoint(x, y)?.closest(".sys-coach-tip"),
              [b.x + b.width / 2, b.y + b.height / 2],
            );
            expect(hit, `${name} switch under the tip`).toBe(false);
          }
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page.touchscreen.tap(cell.width / 2, cell.height / 2);
        await expect(t).toHaveCount(0);
      });
    });
  });
}

test.describe("phone range toggle", () => {
  for (const [width, height] of [
    [390, 844],
    [360, 780],
  ]) {
    test.describe(`${width}x${height}`, () => {
      test.use({
        viewport: { width, height },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      });
      test("arming the range shows no range tip and spends none", async ({
        page,
      }) => {
        await withShareableProject(async (projectPath) => {
          await openProject(page, projectPath);
          await phone.showTimeline(page);
          await armRange(page);
          await settled(page);
          await expect(tip(page, "Drag across a lane to select")).toHaveCount(
            0,
          );
          await shot(page, `range-phone-${width}x${height}`);
          await page.touchscreen.tap(width / 2, 300);
          expect(await seen(page, "rangeToggle")).toBeNull();
        });
      });
    });
  }
});

test.describe("tablet 820x1180 touch", () => {
  test.use({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  test("arming the range shows the range tip, and a press clears it", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await armRange(page);
      const t = tip(page, "Drag across a lane to select");
      await expect(t).toBeVisible();
      const box = (await t.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(240);
      expect(box.x + box.width).toBeLessThanOrEqual(820);
      await shot(page, "range-tablet-820");
      await page.touchscreen.tap(410, 700);
      await expect(t).toHaveCount(0);
      expect(await seen(page, "rangeToggle")).toBe("1");
    });
  });
});

test.describe("fine pointer desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("selecting, cutting and arming a range show no coach tip", async ({
    page,
  }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await phone.showText(page);
      await page
        .locator(".sys-script-body")
        .getByRole("button", { name: /^my(?: \(.*\))?$/ })
        .first()
        .click();
      await page
        .getByRole("button", { name: /^Cut\b/ })
        .first()
        .click();
      await armRange(page);
      await settled(page);
      await expect(page.locator(".sys-coach-tip")).toHaveCount(0);
      await shot(page, "desktop-1280x800-no-tips");
      for (const id of ["selectionHandles", "undo", "rangeToggle"]) {
        expect(await seen(page, id)).toBeNull();
      }
    });
  });
});
