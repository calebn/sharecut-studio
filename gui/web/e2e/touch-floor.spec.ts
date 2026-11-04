import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { withShareableProject } from "./shareableProject";
import {
  goToStage,
  openPanel,
  openProject,
  openViewSheet,
  phone,
  saveStatus,
} from "./stageNav";

/**
 * The 44 CSS px floor on a coarse pointer (docs/communication-philosophy.md, mobile checklist).
 * Every visible control under the floor must match a documented exception below; anything else
 * fails. The exceptions are not resized on purpose:
 * - canvas dense targets (`.fade-corner`, `.trim-handle`, `.track-headers-well`): the
 *   dense-target pattern, with 44px inspector fields and nudges as the equivalent;
 * - transcript text (`.sys-script-word`, and `.sys-script-time` timestamps but not the
 *   speaker name, which opens the speaker popover): inline words in running text,
 *   where a taller hit area would take the neighbouring line's taps; the transport seeks at
 *   44px, while the ruler is 24px by design and is in the `DENSE` exemption of
 *   `e2e-compat/reachability-sweep.spec.ts`;
 */
const DOCUMENTED_EXCEPTIONS = [
  ".fade-corner",
  ".trim-handle",
  ".track-headers-well",
  ".sys-script-word",
  ".sys-script-time",
  ".sys-marker-hit",
  ".pending-hit",
  ".pending-handle",
];
const FLOOR_PX = 44 - 0.5;
const CONTROLS =
  "button, a[href], [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=menuitemcheckbox], [role=menuitemradio], [role=switch], input, select, textarea, summary";
const STAGES = ["record", "prepare", "edit", "review", "deliver"] as const;

/** Visible controls whose touch target is under the floor and not a documented exception. */
async function undersized(page: Page, exceptions: string, scope = "body") {
  return page.evaluate(
    ({ controls, exceptions, floor, scope }) => {
      const out: string[] = [];
      const root = document.querySelector(scope);
      for (const el of root?.querySelectorAll(controls) ?? []) {
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
        if (r.width >= floor && r.height >= floor) continue;
        const name = (el.getAttribute("aria-label") || el.textContent || "")
          .trim()
          .slice(0, 28);
        out.push(
          `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${name}" ${r.width.toFixed(0)}x${r.height.toFixed(0)}`,
        );
      }
      return out;
    },
    { controls: CONTROLS, exceptions, floor: FLOOR_PX, scope },
  );
}

const SIZES = [
  { name: "phone 390x844", width: 390, height: 844, phone: true },
  { name: "tablet 820x1180", width: 820, height: 1180, phone: false },
  { name: "landscape 932x432", width: 932, height: 432, phone: false },
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
    await openProject(page, e2eProjectPath);
    await expect(saveStatus(page)).toBeVisible();
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const exceptions = DOCUMENTED_EXCEPTIONS.join(", ");
    const found: string[] = (await undersized(page, exceptions)).map(
      (row) => `[Fresh] ${row}`,
    );
    for (const stage of STAGES) {
      await goToStage(page, stage);
      found.push(
        ...(await undersized(page, exceptions)).map(
          (row) => `[${stage}] ${row}`,
        ),
      );
    }
    await openPanel(page, "queue");
    found.push(
      ...(await undersized(page, exceptions)).map((row) => `[queue] ${row}`),
    );
    // The Review comment field (C) holds the floor too.
    await page.keyboard.press("c");
    await expect(
      page
        .locator(".rv-compose")
        .getByRole("textbox", { name: "Comment", exact: true }),
    ).toBeVisible();
    found.push(
      ...(await undersized(page, exceptions)).map((row) => `[composer] ${row}`),
    );
    if (size.phone) {
      await phone.showText(page);
      found.push(
        ...(await undersized(page, exceptions)).map((row) => `[Script] ${row}`),
      );
    }
    // The eye sheet holds the overlay layers: its rows hold the floor and the
    // last one is reachable in a short window.
    const sheet = await openViewSheet(page);
    const layers = sheet.locator(".overlay-legend-item");
    expect(await layers.count()).toBeGreaterThan(0);
    found.push(
      ...(await undersized(page, exceptions)).map((row) => `[View] ${row}`),
    );
    const last = layers.last();
    await last.scrollIntoViewIfNeeded();
    const box = (await last.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    expect(found).toEqual([]);
    await context.close();
  });
}

for (const size of SIZES.filter(
  (s) => s.name.startsWith("phone") || s.name.startsWith("tablet"),
)) {
  test(`coarse pointer, ${size.name}: a Decided comment row and its toggle hold 44px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await withShareableProject(async (projectPath) => {
      for (const [index, body] of ["Open question", "Settled note"].entries()) {
        await postDocumentCommand(
          page,
          `floor-comment-${index}`,
          "AddComment",
          {
            body,
            author: "Host reviewer",
            timeline_start: index + 1,
            timeline_end: null,
            track_ids: [],
            action_texts: [],
          },
          projectPath,
        );
      }
      const snapshot = await page.request.get(
        `/api/document/comments?path=${encodeURIComponent(projectPath)}`,
      );
      const settled = (await snapshot.json()).comments.find(
        (comment: { body: string }) => comment.body === "Settled note",
      );
      await postDocumentCommand(
        page,
        "floor-resolve",
        "ResolveComment",
        { comment_id: settled.id, by: "Host reviewer", resolved: true },
        projectPath,
      );
      await openProject(page, projectPath);
      await openPanel(page, "comments");
      const panel = page.locator(".rv-stage");
      await expect(panel).toBeVisible();
      if (size.phone)
        await panel.getByRole("button", { name: / of \d+$/ }).click();
      await page.getByRole("button", { name: /^Decided/ }).click();
      const row = page.locator(".sys-queue-row--decided").first();
      await expect(row).toBeVisible();
      const exceptions = DOCUMENTED_EXCEPTIONS.join(", ");
      expect(
        await undersized(page, exceptions, ".rv-group[aria-label='Decided']"),
      ).toEqual([]);
      const box = (await row.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(FLOOR_PX);
    });
    await context.close();
  });
}
