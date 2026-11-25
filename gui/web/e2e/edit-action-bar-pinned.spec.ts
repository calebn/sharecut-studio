import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { openPhoneTimeline } from "./phoneTimeline";
import { runPaletteCommand } from "./stageNav";

const SIZES = [
  { name: "desktop", width: 1280, height: 800, phone: false },
  { name: "tablet", width: 820, height: 1180, phone: false },
  { name: "phone", width: 390, height: 844, phone: true },
  { name: "phone 320", width: 320, height: 640, phone: true },
] as const;

const FILLER = { reason: "filler:um", inspect: false };

const bar = (page: Page) =>
  page.getByRole("group", { name: /^(Selection|Edit) actions$/ });
const anchor = (page: Page) => page.locator("[data-pending-id]").first();

async function pendingIds(page: Page): Promise<string[]> {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  const project = (await response.json()) as {
    pending_edits: { id: string }[];
  };
  return project.pending_edits.map((edit) => edit.id);
}

async function withSelectedEdit(
  page: Page,
  size: { width: number; height: number },
  phone: boolean,
  run: () => Promise<void>,
): Promise<void> {
  const before = new Set(await pendingIds(page));
  await openSuggestedPendingEdit(page, e2eProjectPath, FILLER);
  try {
    await page.setViewportSize(size);
    if (phone) await openPhoneTimeline(page);
    await run();
  } finally {
    const created = (await pendingIds(page)).filter((id) => !before.has(id));
    await postDocumentCommand(page, "e2e-action-bar-pinned", "RejectEdits", {
      ids: created,
    });
  }
}

const playheadText = (page: Page) =>
  page.evaluate(
    () => document.querySelector(".timecode-current")?.textContent ?? "",
  );

for (const size of SIZES) {
  test.describe(`${size.name}: the Action bar follows a selection that scrolled away`, () => {
    test.use({
      viewport: { width: 1280, height: 800 },
      hasTouch: size.phone,
      isMobile: size.phone,
    });

    test("keeps its verbs on screen, and Show edit brings the edit back", async ({
      page,
    }) => {
      await withSelectedEdit(page, size, size.phone, async () => {
        const actions = bar(page);
        const show = actions.getByRole("button", { name: "Show edit" });
        if (size.phone) {
          // The dock has no pin state: it always carries Show edit, in the
          // one trailing slot, and fits the screen with the verbs.
          await expect(show).toBeVisible();
          await expect(actions).toBeInViewport({ ratio: 1 });
          await expect(
            actions.getByRole("button", { name: "Cut", exact: true }),
          ).toBeEnabled();
          await expect(
            actions.getByRole("button", { name: "Clear selection" }),
          ).toBeVisible();
          await expectPageAxeClean(page);
          const playhead = await playheadText(page);
          await show.click();
          await expect(
            anchor(page).locator('[aria-pressed="true"]'),
          ).toHaveCount(1);
          expect(await playheadText(page)).toBe(playhead);
          return;
        }
        await expect(anchor(page)).toBeInViewport();
        await expect(show).toBeHidden();

        // The whole episode fits the window at the start; zoom in so the
        // timeline scrolls, as it does for a long episode.
        for (let step = 0; step < 4; step++)
          await runPaletteCommand(page, "Zoom in");
        await expect(anchor(page)).toBeInViewport();
        await expect(actions).toBeVisible();
        const playhead = await playheadText(page);
        await page.evaluate(() => {
          const scroller =
            document.querySelector<HTMLElement>(".timeline-scroll");
          if (scroller) scroller.scrollLeft = scroller.scrollWidth;
        });

        await expect(show).toBeVisible();
        await expect(actions).toBeInViewport({ ratio: 1 });
        await expect(
          actions.getByRole("button", { name: "Cut", exact: true }),
        ).toBeEnabled();
        await expect(
          actions.getByRole("button", { name: "Keep", exact: true }),
        ).toBeEnabled();
        await expectPageAxeClean(page);
        await show.click();

        await expect(anchor(page)).toBeInViewport();
        await expect(show).toBeHidden();
        await expect(anchor(page).locator('[aria-pressed="true"]')).toHaveCount(
          1,
        );
        expect(await playheadText(page)).toBe(playhead);
      });
    });
  });
}
