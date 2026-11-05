import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { goToStage, phone as stagePhone } from "./stageNav";

const SERVER_TEXT =
  "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine, then `podcast transcript refine-done`, or `podcast transcript refine-waive --reason ...`.";

const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 640 },
] as const;

for (const phone of PHONES) {
  test(`a replayed Approve the refine gate refuses can be waived from the Review queue's Needs attention rows at ${phone.width}x${phone.height}`, async ({
    page,
  }) => {
    let online = false;
    await page.route("**/api/document/command**", async (route) => {
      const body = route.request().postDataJSON() as { type?: string } | null;
      if (body?.type !== "ApproveEdits") return route.continue();
      if (!online) return route.abort("internetdisconnected");
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
        body: JSON.stringify({ detail: SERVER_TEXT }),
      });
    });
    const waivers: unknown[] = [];
    await page.route("**/api/transcript/refine/waive", async (route) => {
      waivers.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await openSuggestedPendingEdit(page, e2eProjectPath);
    await page.setViewportSize(phone);
    await stagePhone.showTimeline(page);
    const sheet = page.locator(".sys-inspector--phone");
    await sheet
      .getByRole("button", { name: "Approve", exact: true })
      .first()
      .click();

    await goToStage(page, "review");
    // On a phone the queue is a sheet, and its button says something needs attention.
    await page.getByRole("button", { name: /Needs attention$/ }).click();
    const banner = page.getByRole("group", { name: /^Needs attention/ });
    await expect(banner).toBeVisible();
    online = true;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const waive = banner.getByRole("button", { name: "Waive with reason" });
    await waive.scrollIntoViewIfNeeded();
    await expect(waive).toBeVisible();
    await expect(waive).toBeInViewport();
    const field = banner.getByLabel("Waiver reason");
    await expect(field).toBeInViewport();
    await expect
      .poll(() =>
        waive.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          return (
            document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            ) === button
          );
        }),
      )
      .toBe(true);
    await expect(banner).not.toContainText(
      /podcast transcript|ApproveEdits|refine-waive|transcript_refine/,
    );
    await banner.getByLabel("Waiver reason").fill("episode is a rerun");
    await waive.click();
    await expect(banner.getByRole("status")).toContainText("Waiver recorded");
    expect(waivers).toEqual([
      { path: e2eProjectPath, reason: "episode is a rerun" },
    ]);
  });
}
