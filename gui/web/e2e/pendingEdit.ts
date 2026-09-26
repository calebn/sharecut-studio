import { expect, type Page } from "@playwright/test";
import { e2eProjectPath } from "./env";

/**
 * Suggest a cut and open its pending edit in the inspector.
 *
 * Specs share one live project, so earlier specs leave `guest:suggest` rows
 * behind. Pick the row by the id from this spec's own `SuggestPendingEdit`
 * response instead of the last `guest:suggest` row.
 */
export async function openSuggestedPendingEdit(page: Page): Promise<void> {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  const suggested = page.waitForResponse((res) => {
    if (!res.url().includes("/api/document/command")) return false;
    const body = res.request().postDataJSON() as { type?: string } | null;
    return body?.type === "SuggestPendingEdit" && res.ok();
  });
  await page.getByRole("button", { name: "Suggest cut" }).click();
  const response = await suggested;
  const result = (await response.json()) as {
    command?: { payload?: { result?: { id?: string } } };
  };
  const editId = result.command?.payload?.result?.id;
  expect(editId, "SuggestPendingEdit returned the new edit id").toBeTruthy();
  const panels = page.getByLabel("Editor panels");
  await panels.getByRole("button", { name: "Impact" }).click();
  await panels.locator(`[data-pending-id="${editId}"]`).click();
  await expect(
    page.getByRole("heading", { name: "Pending edit" }),
  ).toBeVisible();
}
