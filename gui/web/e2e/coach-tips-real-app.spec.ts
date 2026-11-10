import { expect, type Page, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import { armRange, openProject, phone, reloadProject } from "./stageNav";
import { buildFixture, setZoom, TRACK, visiblePoint } from "./touchTimeline";

/**
 * Coach tips driven through the built app: the Script handles tip and the Undo
 * tip on a phone, the trim tip on a selected clip, nothing on a fine pointer,
 * and the range tip on a tablet but not a phone. Set COACH_SHOTS to a folder to
 * save screenshots.
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
        await reloadProject(page);
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

const TRIM_TIP = "Drag the edges to trim";

type Rect = { x: number; y: number; width: number; height: number };

const overlaps = (a: Rect, b: Rect) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

const setRoot = (page: Page, px: number) =>
  page.evaluate((v) => {
    document.documentElement.style.fontSize = `${v}px`;
  }, px);

/** Where the lanes show: right of the track headers, under the sticky ruler and markers. */
const lanesWindow = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector(".timeline-scroll")!;
    const s = scroller.getBoundingClientRect();
    const headers = scroller.querySelector(".track-headers");
    let top = s.top;
    for (const row of scroller.querySelectorAll(
      ".timeline-ruler, .marker-lane",
    ))
      top = Math.max(top, row.getBoundingClientRect().bottom);
    return {
      left: Math.max(s.left, headers?.getBoundingClientRect().right ?? 0),
      top,
      right: s.left + scroller.clientWidth,
      bottom: s.top + scroller.clientHeight,
    };
  });

/** The tip is whole, on top, inside the frame and the lanes' window, 44 px to close, and clear of the selected clip's start handle. */
async function expectTipUsable(
  page: Page,
  viewport: { width: number; height: number },
  root = 16,
) {
  const t = tip(page, TRIM_TIP);
  await expect(t).toBeVisible();
  const tb = (await t.boundingBox())!;
  expect(tb.width).toBeLessThanOrEqual(15 * root);
  expect(tb.x).toBeGreaterThanOrEqual(0);
  expect(tb.x + tb.width).toBeLessThanOrEqual(viewport.width);
  expect(tb.y).toBeGreaterThanOrEqual(0);
  expect(tb.y + tb.height).toBeLessThanOrEqual(viewport.height);
  const win = await lanesWindow(page);
  expect(tb.x).toBeGreaterThanOrEqual(win.left - 1);
  expect(tb.x + tb.width).toBeLessThanOrEqual(win.right + 1);
  expect(tb.y).toBeGreaterThanOrEqual(win.top - 1);
  expect(tb.y + tb.height).toBeLessThanOrEqual(win.bottom + 1);
  const close = (await t
    .getByRole("button", { name: "Dismiss hint" })
    .boundingBox())!;
  expect(close.width).toBeGreaterThanOrEqual(44);
  expect(close.height).toBeGreaterThanOrEqual(44);
  expect(close.x + close.width).toBeLessThanOrEqual(viewport.width);
  const onTop = await page.evaluate(
    ([r, c]) => {
      const mine = (x: number, y: number) =>
        !!document.elementFromPoint(x, y)?.closest(".sys-coach-tip");
      const pts = [
        [r.x + 4, r.y + 4],
        [r.x + r.width - 4, r.y + 4],
        [r.x + 4, r.y + r.height - 4],
        [r.x + r.width - 4, r.y + r.height - 4],
        [r.x + r.width / 2, r.y + r.height / 2],
        [c.x + c.width / 2, c.y + c.height / 2],
      ];
      return pts.every(([x, y]) => mine(x, y));
    },
    [tb, close] as const,
  );
  expect(onTop).toBe(true);
  const handle = await page
    .locator(".clip-block.selected .trim-handle.in")
    .first()
    .boundingBox();
  if (handle) expect(overlaps(tb, handle)).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  return t;
}

async function tapClip(page: Page, which: "first" | "last") {
  const clips = page.getByTestId("timeline-clip");
  const clip = which === "first" ? clips.first() : clips.last();
  await clip.scrollIntoViewIfNeeded();
  const b = (await clip.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  return clip;
}

/** Tap the body of the clip with `id` where the lanes show it. */
async function tapClipById(page: Page, id: string) {
  const sel = `[data-testid="timeline-clip"][data-clip-id="${id}"]`;
  const at = (await visiblePoint(page, sel, 0.5, 0.95))!;
  await page.touchscreen.tap(at.x, at.y);
}

async function trimTipRoundTrip(
  page: Page,
  {
    width,
    height,
    which,
    root = 16,
  }: { width: number; height: number; which: "first" | "last"; root?: number },
) {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await phone.showTimeline(page);
    if (root !== 16) await setRoot(page, root);
    const clip = await tapClip(page, which);
    const t = await expectTipUsable(page, { width, height }, root);
    await shot(page, `trim-tip-${width}x${height}-r${root}-${which}`);
    await page.touchscreen.tap(width / 2, height - 8);
    await expect(t).toHaveCount(0);
    expect(await seen(page, "trim")).toBe("1");
    await reloadProject(page);
    await phone.showTimeline(page);
    if (root !== 16) await setRoot(page, root);
    await tapClip(page, which);
    await expect(clip.locator(".trim-handle.in")).toBeVisible();
    await settled(page);
    await expect(t).toHaveCount(0);
  });
}

test.describe("trim tip", () => {
  for (const [width, height, root] of [
    [390, 844, 16],
    [360, 780, 16],
    [820, 1180, 16],
    [844, 390, 16],
    [390, 844, 32],
    [360, 780, 32],
  ]) {
    for (const which of ["first", "last"] as const) {
      test.describe(`${width}x${height} text ${root * 6.25}% ${which} lane`, () => {
        test.use({
          viewport: { width, height },
          hasTouch: true,
          isMobile: true,
          reducedMotion: "reduce",
        });
        test("selecting a clip shows the tip clear of its handle, a press clears it, it never returns", ({
          page,
        }) => trimTipRoundTrip(page, { width, height, which, root }));
      });
    }
  }
});

test.describe("trim tip on a narrow clip", () => {
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
      test("a 10 s clip at fit zoom shows the whole tip beside its start and keeps it until a press", async ({
        page,
      }) => {
        await withShareableProject(async (projectPath) => {
          await openProject(page, projectPath);
          await buildFixture(page, projectPath, "e2e-trim-tip");
          await reloadProject(page);
          await phone.showTimeline(page);
          await expect(
            page.locator(
              `.lane-row[data-track-id="${TRACK}"] [data-testid="timeline-clip"]`,
            ),
          ).toHaveCount(4);
          await setZoom(page, 0);
          const ids = await page.evaluate(
            (track) =>
              [
                ...document.querySelectorAll<HTMLElement>(
                  `.lane-row[data-track-id="${track}"] [data-testid="timeline-clip"]`,
                ),
              ].map((c) => c.getAttribute("data-clip-id")!),
            TRACK,
          );
          const narrow = page.locator(
            `[data-testid="timeline-clip"][data-clip-id="${ids[0]}"]`,
          );
          expect((await narrow.boundingBox())!.width).toBeLessThan(120);
          await tapClipById(page, ids[0]);
          const t = await expectTipUsable(page, { width, height });
          await shot(page, `trim-tip-narrow-${width}x${height}`);
          await page.touchscreen.tap(width / 2, height - 8);
          await expect(t).toHaveCount(0);
          expect(await seen(page, "trim")).toBe("1");
        });
      });
    });
  }
});

test.describe("trim tip on a clip scrolled under the headers", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  for (const off of [60, 280]) {
    test(`a clip whose start is ${off} px under the headers shows the tip inside the lanes`, async ({
      page,
    }) => {
      await withShareableProject(async (projectPath) => {
        await openProject(page, projectPath);
        await phone.showTimeline(page);
        await setZoom(page, 6);
        const clip = page.getByTestId("timeline-clip").first();
        await page.evaluate((px) => {
          const scroller = document.querySelector(".timeline-scroll")!;
          const headers = scroller.querySelector(".track-headers")!;
          const clipEl = document.querySelector(
            '[data-testid="timeline-clip"]',
          )!;
          scroller.scrollLeft +=
            headers.getBoundingClientRect().right -
            clipEl.getBoundingClientRect().left +
            px;
        }, off);
        await settled(page);
        const id = (await clip.getAttribute("data-clip-id"))!;
        expect((await clip.boundingBox())!.x).toBeLessThan(
          (await lanesWindow(page)).left - off + 2,
        );
        await tapClipById(page, id);
        const t = await expectTipUsable(page, { width: 390, height: 844 });
        await shot(page, `trim-tip-scrolled-${off}`);
        await page.touchscreen.tap(195, 836);
        await expect(t).toHaveCount(0);
        expect(await seen(page, "trim")).toBe("1");
      });
    });
  }
});

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
  test("selecting text, cutting and arming a range show no coach tip", async ({
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

  test("selecting a clip with a mouse shows no trim tip", async ({ page }) => {
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      const clip = page.getByTestId("timeline-clip").first();
      await clip.click();
      await expect(clip).toHaveClass(/\bselected\b/);
      await settled(page);
      await expect(page.locator(".sys-coach-tip")).toHaveCount(0);
      expect(await seen(page, "trim")).toBeNull();
    });
  });
});
