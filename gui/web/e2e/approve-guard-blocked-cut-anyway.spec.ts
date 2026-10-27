import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { openProject } from "./stageNav";

async function pendingIds(page: Page): Promise<string[]> {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  const project = (await response.json()) as {
    pending_edits: { id: string }[];
  };
  return project.pending_edits.map((edit) => edit.id);
}

const APPROVED = { ok: true, command: { payload: { result: { count: 1 } } } };

test("explicit interactive approval sends one command without an override flag", async ({
  page,
}) => {
  const approvals: Record<string, unknown>[] = [];
  await openProject(page, e2eProjectPath);
  const before = new Set(await pendingIds(page));
  await openSuggestedPendingEdit(page, e2eProjectPath);
  try {
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
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(APPROVED),
      });
    });

    await page
      .getByRole("region", { name: "Pending edit actions" })
      .getByRole("button", { name: "Approve", exact: true })
      .click();

    await expect.poll(() => approvals.length).toBe(1);
    expect(approvals[0]).not.toHaveProperty("confirm_cut_speech");
    await expect(page.getByRole("button", { name: "Cut anyway" })).toHaveCount(
      0,
    );
    await expect(
      page
        .getByRole("region", { name: "Status messages" })
        .getByText("Approved 1 pending edit", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.unroute("**/api/document/command**");
    const created = (await pendingIds(page)).filter((id) => !before.has(id));
    await postDocumentCommand(
      page,
      "e2e-approve-guard-blocked",
      "RejectEdits",
      {
        ids: created,
      },
    );
  }
});
