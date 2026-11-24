import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";

test.use({ viewport: { width: 1280, height: 800 } });

const REFUSED = new Map([
  [409, "Edit changed"],
  [400, "Range overlaps an exact-range edit"],
]);

async function pendingIds(page: Page): Promise<string[]> {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  const project = (await response.json()) as {
    pending_edits: { id: string }[];
  };
  return project.pending_edits.map((edit) => edit.id);
}

for (const [status, detail] of REFUSED) {
  test(`a ${status} on a dragged end edge says so and puts the edge back`, async ({
    page,
  }) => {
    const before = new Set(await pendingIds(page));
    await openSuggestedPendingEdit(page, e2eProjectPath, {
      reason: "filler:um",
      inspect: false,
    });
    try {
      let refused = 0;
      await page.route("**/api/document/command**", async (route) => {
        const body = route.request().postDataJSON() as { type?: string } | null;
        if (body?.type !== "UpdatePendingEdit") return route.continue();
        refused += 1;
        return route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ detail }),
        });
      });
      const region = page.locator(".pending-overlay.selected").first();
      await region.locator(".pending-hit").focus();
      for (
        let step = 0;
        step < 12 && ((await region.boundingBox())?.width ?? 0) < 132;
        step += 1
      )
        await page.keyboard.press("=");
      const end = region.locator(".pending-handle.end");
      await expect(end).toBeVisible();
      const home = (await end.boundingBox())!;
      const x = home.x + home.width / 2;
      const y = home.y + home.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 40, y, { steps: 6 });
      await page.mouse.up();
      await expect
        .poll(() => refused, { message: "the save was sent and refused" })
        .toBe(1);
      const sentence =
        "That edit's end was not saved, so it is back where it was. Move the edge again or pick a different range.";
      const said = page
        .getByRole("region", { name: "Status messages" })
        .getByText(sentence);
      await expect(said).toBeVisible();
      // The live region itself speaks it, and nothing replaces it later: no
      // Needs attention summary and no server text.
      const live = page
        .getByRole("status")
        .and(page.locator(".sr-only[aria-live]"))
        .filter({ hasText: sentence });
      await expect(live).toHaveText(sentence);
      await page.waitForTimeout(3000);
      await expect(live).toHaveText(sentence);
      await expect(page.getByText(detail)).toHaveCount(0);
      await expect
        .poll(async () => (await end.boundingBox())?.x ?? Number.NaN)
        .toBeCloseTo(home.x, 0);
    } finally {
      await page.unroute("**/api/document/command**");
      const created = (await pendingIds(page)).filter((id) => !before.has(id));
      await postDocumentCommand(page, "e2e-refused-retime", "RejectEdits", {
        ids: created,
      });
    }
  });
}
