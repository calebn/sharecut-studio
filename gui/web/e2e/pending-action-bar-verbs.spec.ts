import { expect, type Page, test } from "@playwright/test";
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

const APPROVED = {
  ok: true,
  history_head_id: "e2e-head",
  review_result: { count: 1, held: [] },
  command: { payload: { result: { count: 1 } } },
};

const FILLER = { reason: "filler:um", inspect: false };

const editActions = (page: Page) =>
  page.getByRole("group", { name: /^(Selection|Edit) actions$/ });

async function withSuggestion(
  page: Page,
  phone: boolean,
  run: () => Promise<void>,
): Promise<void> {
  const before = new Set(await pendingIds(page));
  await openSuggestedPendingEdit(page, e2eProjectPath, FILLER);
  try {
    if (phone) {
      await page.setViewportSize({ width: 390, height: 844 });
      await openPhoneTimeline(page);
    }
    await run();
  } finally {
    await page.unroute("**/api/document/command**");
    const created = (await pendingIds(page)).filter((id) => !before.has(id));
    await postDocumentCommand(page, "e2e-pending-action-bar", "RejectEdits", {
      ids: created,
    });
  }
}

for (const shell of [
  { name: "desktop", phone: false },
  { name: "phone", phone: true },
]) {
  test.describe(`${shell.name}: a cut suggestion's verbs are the Action bar's`, () => {
    test.use({
      viewport: { width: 1280, height: 800 },
      hasTouch: shell.phone,
      isMobile: shell.phone,
    });

    test("Cut on the bar decides it once and no overlay bar shows", async ({
      page,
    }) => {
      const approvals: Record<string, unknown>[] = [];
      await page.route("**/api/document/command**", async (route) => {
        const body = route.request().postDataJSON() as {
          type?: string;
          payload?: Record<string, unknown>;
        } | null;
        if (body?.type !== "ApproveEdits") return route.continue();
        approvals.push(body.payload ?? {});
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(APPROVED),
        });
      });
      await withSuggestion(page, shell.phone, async () => {
        await expect(
          page.getByRole("region", { name: "Pending edit actions" }),
        ).toHaveCount(0);
        await expect(page.locator(".pending-actionbar")).toHaveCount(0);
        const cut = editActions(page).getByRole("button", {
          name: "Cut",
          exact: true,
        });
        await expect(cut).toBeVisible();
        await expect(
          editActions(page).getByRole("button", { name: "Keep", exact: true }),
        ).toBeVisible();
        await cut.click();
        await expect.poll(() => approvals.length).toBe(1);
        await expect(
          page
            .getByRole("region", { name: "Status messages" })
            .getByText("Approved 1 pending edit", { exact: true }),
        ).toBeVisible();
        await expect(cut).toHaveCount(0);
      });
    });

    test("Inspect on the bar puts focus on the Start field", async ({
      page,
    }) => {
      await withSuggestion(page, shell.phone, async () => {
        await inspectSelection(page);
        await expect(
          page.getByLabel("Source start", { exact: true }),
        ).toBeFocused();
      });
    });
  });
}
