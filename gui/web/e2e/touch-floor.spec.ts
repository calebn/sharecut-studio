import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

/**
 * The 44 CSS px floor on a coarse pointer (docs/communication-philosophy.md, mobile checklist).
 * Every visible control under the floor must match a documented exception below; anything else
 * fails. The exceptions are not resized on purpose:
 * - canvas dense targets (`.fade-corner`, `.trim-handle`, `.track-headers-well`): the
 *   dense-target pattern, with 44px inspector fields and nudges as the equivalent;
 * - transcript text (`.utterance-word`, `.utterance-seek`): inline words in running text, where
 *   a taller hit area would take the neighbouring line's taps; the ruler and transport seek at 44px;
 * - `.track-reorder-handle`: a drag shortcut whose equivalent is the 44px Move up/down buttons;
 * - `.status-chip`: tablet and desktop status bar chips; the tab strip carries the same actions.
 */
const DOCUMENTED_EXCEPTIONS =
  ".fade-corner, .trim-handle, .track-headers-well, .utterance-word, .utterance-seek, .track-reorder-handle, .status-chip";
const FLOOR_PX = 44 - 0.5;
const CONTROLS =
  "button, a[href], [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], input, select, textarea, summary";
const MODES = ["Listen", "Timeline", "Text", "More"] as const;

/** Visible controls whose touch target is under the floor and not a documented exception. */
async function undersized(page: Page) {
  return page.evaluate(
    ({ controls, exceptions, floor }) => {
      const out: string[] = [];
      for (const el of document.querySelectorAll(controls)) {
        if (el.matches(exceptions)) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.pointerEvents === "none")
          continue;
        // A native checkbox or radio is the label's glyph; the label is the target.
        const target =
          el instanceof HTMLInputElement &&
          (el.type === "checkbox" || el.type === "radio")
            ? (el.closest("label") ?? el)
            : el;
        const r = target.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.bottom < 0 || r.top > innerHeight) continue;
        if (r.right < 0 || r.left > innerWidth) continue;
        if (r.width >= floor && r.height >= floor) continue;
        const name = (
          el.getAttribute("aria-label") ||
          el.textContent ||
          ""
        )
          .trim()
          .slice(0, 28);
        out.push(
          `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${name}" ${r.width.toFixed(0)}x${r.height.toFixed(0)}`,
        );
      }
      return out;
    },
    { controls: CONTROLS, exceptions: DOCUMENTED_EXCEPTIONS, floor: FLOOR_PX },
  );
}

const SIZES = [
  { name: "phone 390x844", width: 390, height: 844 },
  { name: "tablet 820x1180", width: 820, height: 1180 },
  { name: "landscape 932x432", width: 932, height: 432 },
];

for (const size of SIZES) {
  test(`coarse pointer, ${size.name}: no control is under 44px without a documented exception`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.locator("[data-save-state]")).toBeVisible();
    const found: string[] = [];
    const nav = page.getByRole("navigation", { name: "Primary" });
    if (await nav.count()) {
      for (const name of MODES) {
        await nav.getByRole("button", { name, exact: true }).click();
        found.push(...(await undersized(page)).map((row) => `[${name}] ${row}`));
      }
    } else {
      found.push(...(await undersized(page)));
    }
    expect(found).toEqual([]);
    await context.close();
  });
}
