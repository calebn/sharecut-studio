import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";

async function pendingIds(page: Page): Promise<string[]> {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  const project = (await response.json()) as {
    pending_edits: { id: string }[];
  };
  return project.pending_edits.map((edit) => edit.id);
}

const ASKED = {
  ok: true,
  unchanged: true,
  needs_confirmation: {
    status: "needs_confirmation",
    reason: "cuts_other_speech",
    message:
      "This also cuts Caleb's speech. Cut anyway, or leave a gap to keep it.",
    confirm_label: "Cut anyway",
    confirm_field: "confirm_cut_speech",
    speech: {
      spans: [{ start: 0, end: 2 }],
      tracks: [
        {
          track_id: "caleb",
          speaker: "Caleb",
          words: [{ text: "right", timeline_start: 0.4, timeline_end: 0.8 }],
          sound_spans: [],
        },
      ],
    },
  },
};

test("approving a pending cut a peer speaks over asks Cut anyway, then sends it confirmed", async ({
  page,
}) => {
  const approvals: Record<string, unknown>[] = [];
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  const before = new Set(await pendingIds(page));
  await openSuggestedPendingEdit(page, e2eProjectPath);
  await page.route("**/api/document/command**", async (route) => {
    const body = route.request().postDataJSON() as {
      type?: string;
      payload?: Record<string, unknown>;
    } | null;
    if (body?.type !== "ApproveEdits") {
      await route.continue();
      return;
    }
    approvals.push(body.payload ?? {});
    const confirmed = body.payload?.confirm_cut_speech === true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(confirmed ? { ok: true } : ASKED),
    });
  });

  await page
    .getByRole("region", { name: "Pending edit actions" })
    .getByRole("button", { name: "Approve", exact: true })
    .click();

  const dialog = page.getByRole("dialog", { name: "Cut Caleb's speech too?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Caleb at 0:00.4");
  await expect(dialog.getByRole("button", { name: "Leave a gap" })).toHaveCount(
    0,
  );
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).not.toHaveProperty("confirm_cut_speech");

  await dialog.getByRole("button", { name: "Cut anyway" }).click();

  await expect(dialog).toBeHidden();
  expect(approvals).toHaveLength(2);
  expect(approvals[1]).toMatchObject({ confirm_cut_speech: true });

  await page.unroute("**/api/document/command**");
  const created = (await pendingIds(page)).filter((id) => !before.has(id));
  await postDocumentCommand(page, "e2e-approve-guard-blocked", "RejectEdits", {
    ids: created,
  });
});
