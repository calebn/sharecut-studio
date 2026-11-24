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

    test("Cut on the bar decides it once and the Action bar is the only bar", async ({
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
        await expect(editActions(page)).toHaveCount(1);
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

const REFINE_REFUSAL = {
  status: 409,
  contentType: "application/json",
  headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
  body: JSON.stringify({
    detail: "Transcript refine is required before focus/tighten/NL edits.",
  }),
};

test.describe("desktop: Keep, a refused Cut and an edge drag still settling", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Keep on the bar rejects the suggestion through the real server", async ({
    page,
  }) => {
    const before = new Set(await pendingIds(page));
    const commands: string[] = [];
    page.on("request", (request) => {
      if (!request.url().includes("/api/document/command")) return;
      const type = (request.postDataJSON() as { type?: string } | null)?.type;
      if (type) commands.push(type);
    });
    await withSuggestion(page, false, async () => {
      const created = (await pendingIds(page)).filter((id) => !before.has(id));
      expect(created).toHaveLength(1);
      await editActions(page)
        .getByRole("button", { name: "Keep", exact: true })
        .click();
      await expect
        .poll(async () => (await pendingIds(page)).includes(created[0]))
        .toBe(false);
      expect(commands).toContain("RejectEdits");
      expect(commands).not.toContain("ApproveEdits");
    });
  });

  test("a Cut the server refuses for the transcript check opens the sheet to Cut anyway", async ({
    page,
  }) => {
    await page.route("**/api/document/command**", async (route) => {
      const body = route.request().postDataJSON() as { type?: string } | null;
      if (body?.type === "ApproveEdits") return route.fulfill(REFINE_REFUSAL);
      return route.continue();
    });
    await withSuggestion(page, false, async () => {
      await editActions(page)
        .getByRole("button", { name: "Cut", exact: true })
        .click();
      const status = page.getByRole("region", { name: "Status messages" });
      await expect(status).toContainText(/transcript isn.t checked yet/i);
      await status.getByRole("button", { name: "Open Inspect" }).click();
      await expect(
        page.getByRole("button", { name: "Cut anyway" }),
      ).toBeVisible();
    });
  });

  test("Cut waits for an edge drag's snap lookup and save instead of cutting the old bounds", async ({
    page,
  }) => {
    const sent: string[] = [];
    page.on("request", (request) => {
      if (!request.url().includes("/api/document/command")) return;
      const type = (request.postDataJSON() as { type?: string } | null)?.type;
      if (type === "ApproveEdits" || type === "UpdatePendingEdit")
        sent.push(type);
    });
    let releaseSnap: () => void = () => {};
    const snapGate = new Promise<void>((resolve) => {
      releaseSnap = resolve;
    });
    await page.route("**/api/waveform-snap**", async (route) => {
      await snapGate;
      await route.continue();
    });
    await withSuggestion(page, false, async () => {
      const region = page.locator(".pending-overlay.selected").first();
      const hit = region.locator(".pending-hit");
      await hit.focus();
      for (
        let step = 0;
        step < 12 && ((await region.boundingBox())?.width ?? 0) < 132;
        step += 1
      )
        await page.keyboard.press("=");
      const end = region.locator(".pending-handle.end");
      await expect(end).toBeVisible();
      const box = (await end.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 40, y, { steps: 6 });
      await page.mouse.up();
      const cut = editActions(page).getByRole("button", {
        name: "Cut",
        exact: true,
      });
      const keep = editActions(page).getByRole("button", {
        name: "Keep",
        exact: true,
      });
      await expect(cut).toBeDisabled();
      await expect(keep).toBeDisabled();
      await page.keyboard.press("Delete");
      expect(sent).toEqual([]);
      releaseSnap();
      await expect.poll(() => sent).toEqual(["UpdatePendingEdit"]);
      await expect(cut).toBeEnabled();
    });
  });
});
