import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openSuggestedPendingEdit } from "./pendingEdit";

const LEAVE = { reason: "filler:acoustic:possible_word", inspect: false };

const clipCount = (): number =>
  JSON.parse(fs.readFileSync(e2eProjectPath, "utf8")).timeline.clips.length;

async function pendingIds(page: Page): Promise<string[]> {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  const project = (await response.json()) as {
    pending_edits: { id: string }[];
  };
  return project.pending_edits.map((edit) => edit.id);
}

async function rejectCreated(page: Page, before: Set<string>) {
  const created = (await pendingIds(page)).filter((id) => !before.has(id));
  if (created.length)
    await postDocumentCommand(page, "e2e-pending-leave", "RejectEdits", {
      ids: created,
    });
}

test.use({ viewport: { width: 1280, height: 800 } });

test("the Action bar Leave button dismisses a leave suggestion and Undo restores it", async ({
  page,
}) => {
  const before = new Set(await pendingIds(page));
  const clipsBefore = clipCount();
  const commands: string[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/document/command")) return;
    const type = (request.postDataJSON() as { type?: string } | null)?.type;
    if (type) commands.push(type);
  });
  await openSuggestedPendingEdit(page, e2eProjectPath, LEAVE);
  try {
    const created = (await pendingIds(page)).filter((id) => !before.has(id));
    expect(created).toHaveLength(1);
    const bar = page.getByRole("group", { name: /^(Selection|Edit) actions$/ });
    await expect(
      bar.getByRole("button", { name: "Approve", exact: true }),
    ).toHaveCount(0);
    await bar.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Status messages" }),
    ).toContainText(/Left|Leave|Applied|dismiss/i);
    await expect.poll(() => pendingIds(page)).not.toContain(created[0]);
    expect(clipCount()).toBe(clipsBefore);
    expect(commands).not.toContain("ApproveEdits");

    await page
      .getByRole("region", { name: "Status messages" })
      .getByRole("button", { name: /^Undo/ })
      .click();
    await expect.poll(() => pendingIds(page)).toContain(created[0]);
    expect(clipCount()).toBe(clipsBefore);
  } finally {
    await rejectCreated(page, before);
  }
});
