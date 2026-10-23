import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";

const SERVER_TEXT =
  "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine, then `podcast transcript refine-done`, or `podcast transcript refine-waive --reason ...`.";

test("a replayed Approve the refine gate refuses can be waived from the Needs attention banner", async ({
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Timeline" }).click();
  const sheet = page.locator(".bottom-sheet--compact");
  await sheet
    .getByRole("button", { name: "Approve", exact: true })
    .first()
    .click();

  const banner = page.getByRole("region", { name: /^Needs attention/ });
  await expect(banner).toBeVisible();
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await banner
    .getByLabel("Needs attention details and recovery actions")
    .click();
  const waive = banner.getByRole("button", { name: "Waive with reason" });
  await expect(waive).toBeVisible();
  await expect(waive).toBeInViewport();
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
