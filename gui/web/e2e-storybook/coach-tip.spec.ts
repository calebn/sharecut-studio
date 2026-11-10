import { devices, expect, type Page, test } from "@playwright/test";
import { storyUrl } from "./storyUrl";

test.use({ ...devices["Pixel 5"] });

const TAPPABLE =
  'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="slider"], [role="switch"], [role="checkbox"]';

async function openStory(
  page: Page,
  id: string,
  size: { width: number; height: number },
  fontSize?: string,
) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(storyUrl(id, { theme: "light" }));
  if (fontSize)
    await page.evaluate((value) => {
      document.documentElement.style.fontSize = value;
    }, fontSize);
}

/** What the tip covers: controls outside the lanes, and whether the tip is the top layer at its corners and centre. */
const measure = (page: Page) =>
  page.evaluate((selector) => {
    const tip = document.querySelector<HTMLElement>(".sys-coach-tip");
    if (!tip) return null;
    const box = tip.getBoundingClientRect();
    const covered: string[] = [];
    for (const el of document.querySelectorAll(selector)) {
      if (tip.contains(el) || el.closest(".timeline-area")) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      if (
        b.left < box.right &&
        b.right > box.left &&
        b.top < box.bottom &&
        b.bottom > box.top
      )
        covered.push(
          el.getAttribute("aria-label") ??
            el.textContent?.trim().slice(0, 24) ??
            el.tagName,
        );
    }
    const points = [
      [box.left + 12, box.top + 12],
      [box.right - 12, box.top + 12],
      [box.left + 12, box.bottom - 12],
      [box.right - 12, box.bottom - 12],
      [box.left + box.width / 2, box.top + box.height / 2],
    ];
    const onTop = points.every(([x, y]) =>
      document.elementFromPoint(x, y)?.closest(".sys-coach-tip"),
    );
    const root = document.documentElement;
    return {
      covered,
      onTop,
      width: box.width,
      start: box.left,
      end: root.clientWidth - box.right,
      top: box.top,
      overflow: root.scrollWidth - root.clientWidth,
    };
  }, TAPPABLE);

for (const [label, width, fontSize] of [
  ["360", 360, undefined],
  ["390", 390, undefined],
  ["360 at 200% text", 360, "200%"],
  ["390 at 200% text", 390, "200%"],
] as const) {
  test(`System/CoachTip undo tip covers no control and stays inside the header at ${label}`, async ({
    page,
  }) => {
    await openStory(
      page,
      "stages-edit-workspace--phone-undo-hint",
      { width, height: 800 },
      fontSize,
    );
    await expect(page.getByRole("note")).toBeVisible();
    const fit = await measure(page);
    expect(fit?.covered).toEqual([]);
    expect(fit?.onTop).toBe(true);
    expect(fit?.width).toBeLessThanOrEqual(fontSize ? 480 : 240);
    expect(fit?.start).toBeGreaterThanOrEqual(0);
    expect(fit?.end).toBeGreaterThanOrEqual(0);
    expect(fit?.overflow).toBeLessThanOrEqual(0);
    // The surface switch and the header Undo still take a press.
    for (const name of ["Timeline", "Script", "Undo"]) {
      const control = page.getByRole("button", { name, exact: true });
      if ((await control.count()) === 0) continue;
      const box = await control.first().boundingBox();
      if (!box) continue;
      const hit = await page.evaluate(
        ([x, y]) =>
          !!document.elementFromPoint(x, y)?.closest(".sys-coach-tip"),
        [box.x + box.width / 2, box.y + box.height / 2],
      );
      expect(hit, name).toBe(false);
    }
  });
}

for (const width of [360, 390]) {
  test(`System/CoachTip range tip is never raised behind the Range sheet at ${width}`, async ({
    page,
  }) => {
    await openStory(page, "stages-edit-workspace--phone-range-hint", {
      width,
      height: 800,
    });
    await expect(page.getByText("In", { exact: true })).toBeVisible();
    const seen = () =>
      page.evaluate(() =>
        localStorage.getItem("sharecut.coachTipSeen.rangeToggle"),
      );
    // Arming opens the docked sheet over the corner: a tip raised there is hidden and then spent unseen.
    expect(await measure(page)).toBeNull();
    await page.mouse.click(width / 2, 200);
    expect(await seen()).toBeNull();
  });
}

test("System/CoachTip range tip shows on a tablet, on top of the lanes", async ({
  page,
}) => {
  await openStory(page, "stages-edit-workspace--tablet-range-hint", {
    width: 820,
    height: 1180,
  });
  await expect(page.getByRole("note")).toBeVisible();
  const fit = await measure(page);
  expect(fit?.onTop).toBe(true);
  expect(fit?.start).toBeGreaterThanOrEqual(0);
  expect(fit?.end).toBeGreaterThanOrEqual(0);
});
