import { expect, type Page } from "@playwright/test";
import { e2eProjectPath } from "./env";

/**
 * Suggest a 0–2 s cut on the first dialogue track through the document plane
 * and open its pending edit in the inspector.
 *
 * The GUI has no one-click "suggest a cut here" control (#532), so the helper
 * sends the `SuggestPendingEdit` command an agent or share guest would send.
 * Specs share one live project, so earlier specs leave `guest:suggest` rows
 * behind. Pick the row by the id from this spec's own response instead of the
 * last `guest:suggest` row.
 */
export async function openSuggestedPendingEdit(page: Page): Promise<void> {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
  const editId = await page.evaluate(async (projectPath) => {
    const query = `?path=${encodeURIComponent(projectPath)}`;
    const project = (await (
      await fetch(`/api/project${query}&phase=shell`)
    ).json()) as { tracks: { id: string; role?: string }[] };
    const track =
      project.tracks.find((t) => t.role === "dialogue") ?? project.tracks[0];
    const res = await fetch(`/api/document/command${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "SuggestPendingEdit",
        payload: {
          track_id: track.id,
          start: 0,
          end: 2,
          reason: "guest:suggest",
        },
        client_id: "e2e-suggest",
        role: "viewer",
        client_seq: Date.now(),
      }),
    });
    const body = (await res.json()) as {
      command?: { payload?: { result?: { id?: string } } };
    };
    return res.ok ? body.command?.payload?.result?.id : undefined;
  }, e2eProjectPath);
  expect(editId, "SuggestPendingEdit returned the new edit id").toBeTruthy();
  const panels = page.getByLabel("Editor panels");
  await panels.getByRole("button", { name: "Impact" }).click();
  await panels.locator(`[data-pending-id="${editId}"]`).click();
  await expect(
    page.getByRole("heading", { name: "Pending edit" }),
  ).toBeVisible();
}
