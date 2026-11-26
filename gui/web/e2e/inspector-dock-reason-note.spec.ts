import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { openPhoneTimeline } from "./phoneTimeline";
import { inspectSelection } from "./stageNav";

async function pendingIds(page: Page): Promise<string[]> {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  const project = (await response.json()) as {
    pending_edits: { id: string }[];
  };
  return project.pending_edits.map((edit) => edit.id);
}

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

const uncovered = (target: Locator) =>
  target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    return hit === el || el.contains(hit);
  });

for (const { width, height, fontSize } of [
  { width: 390, height: 844, fontSize: 16 },
  { width: 320, height: 568, fontSize: 16 },
  { width: 390, height: 844, fontSize: 32 },
  { width: 320, height: 844, fontSize: 32 },
]) {
  test.describe(`${width}x${height} phone at ${fontSize}px root text`, () => {
    test.use({ hasTouch: true });

    test("a gated verb's whole reason fits while Inspector dock controls stay reachable", async ({
      page,
    }) => {
      if (fontSize !== 16) {
        await page.addInitScript((font) => {
          const apply = () => {
            if (!document.documentElement) return false;
            document.documentElement.style.fontSize = font;
            return true;
          };
          if (apply()) return;
          const observer = new MutationObserver(() => {
            if (apply()) observer.disconnect();
          });
          observer.observe(document, { childList: true });
        }, `${fontSize}px`);
      }
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const before = new Set(await pendingIds(page));
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/document/command**", async (route) => {
        const type = (
          route.request().postDataJSON() as { type?: string } | null
        )?.type;
        if (type !== "ApproveEdits") return route.continue();
        await held;
        return route.abort().catch(() => {});
      });
      try {
        await openSuggestedPendingEdit(page, e2eProjectPath, {
          reason: "filler:um",
          inspect: false,
        });
        await expect
          .poll(() =>
            page.evaluate(() =>
              parseFloat(getComputedStyle(document.documentElement).fontSize),
            ),
          )
          .toBe(fontSize);
        await page.setViewportSize({ width, height });
        await openPhoneTimeline(page);
        const sheet = page.getByRole("dialog", {
          name: "Inspector",
          exact: true,
        });
        await inspectSelection(page);
        await expect(sheet).toBeVisible();
        const grip = sheet.getByRole("slider", { name: "Sheet height" });
        await grip.focus();
        await grip.press("Home");
        const dock = sheet.locator(".sys-inspector-dock");
        const verbs = dock.locator(".sys-actions--dock");
        await expect(verbs).toBeVisible();
        await verbs.getByRole("button", { name: "Cut", exact: true }).tap();
        await expect(
          verbs.getByRole("button", { name: "Cut", exact: true }),
        ).toBeVisible();
        const note = dock.locator(".sys-actions-reason");
        await expect(note).toBeVisible();
        expect(await uncovered(note)).toBe(true);
        await frames(page);
        const sheetBox = (await sheet.boundingBox())!;
        const barBox = (await verbs.boundingBox())!;
        expect(barBox.x).toBeGreaterThanOrEqual(sheetBox.x - 1);
        expect(barBox.y).toBeGreaterThanOrEqual(sheetBox.y - 1);
        expect(barBox.x + barBox.width).toBeLessThanOrEqual(
          sheetBox.x + sheetBox.width + 1,
        );
        expect(barBox.y + barBox.height).toBeLessThanOrEqual(
          sheetBox.y + sheetBox.height + 1,
        );
        if (fontSize === 16) {
          const noteBox = (await note.boundingBox())!;
          expect(noteBox.y).toBeGreaterThanOrEqual(sheetBox.y - 1);
          expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(
            sheetBox.y + sheetBox.height + 1,
          );
          expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(barBox.x + 1);
          expect(
            await verbs.evaluate((el) => el.scrollWidth - el.clientWidth),
          ).toBeLessThanOrEqual(1);
          const slot = (await verbs
            .locator(".sys-dock-slot--start")
            .boundingBox())!;
          const controls = verbs.locator(".sys-dock-slot--start button");
          expect(await controls.count()).toBeGreaterThan(0);
          expect(noteBox.width).toBeGreaterThanOrEqual(70);
          for (let i = 0; i < (await controls.count()); i += 1) {
            const box = (await controls.nth(i).boundingBox())!;
            expect(box.width).toBeGreaterThanOrEqual(40);
            expect(box.x + box.width).toBeLessThanOrEqual(
              slot.x + slot.width + 1,
            );
          }
        }
        await expect
          .poll(async () => {
            await frames(page);
            return errors;
          })
          .toEqual([]);
        await expect(verbs).toBeVisible();
        const longReason =
          "Only the host or an Editor can review exact range proposals.";
        await note.evaluate((el, reason) => {
          const text = el.firstChild;
          if (!text || text.nodeType !== Node.TEXT_NODE)
            throw new Error("Missing reason text");
          text.nodeValue = reason;
        }, longReason);
        await expect(note).toHaveText(longReason);
        await expect
          .poll(() =>
            note.evaluate((el) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const sheet = el
                .closest(".sys-inspector")!
                .getBoundingClientRect();
              const lines = Array.from(range.getClientRects());
              return (
                lines.length > 1 &&
                lines.every(
                  (line) =>
                    line.top >= sheet.top - 1 &&
                    line.bottom <= sheet.bottom + 1,
                )
              );
            }),
          )
          .toBe(true);
        await expect(verbs).toBeVisible();
        expect(
          await uncovered(
            verbs.getByRole("button", { name: "Close", exact: true }),
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        release();
        await page.unroute("**/api/document/command**");
        const created = (await pendingIds(page)).filter(
          (id) => !before.has(id),
        );
        await postDocumentCommand(page, "e2e-dock-note", "RejectEdits", {
          ids: created,
        });
      }
    });
  });
}
