import { expect, test } from "@playwright/test";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { withShareableProject } from "./shareableProject";

test("host can waive a blocked approval in the browser", async ({ page }) => {
  await withShareableProject(async (projectPath) => {
    let approvals = 0;
    let waiverReason = "";
    await page.route("**/api/document/command**", async (route) => {
      const body = route.request().postDataJSON() as { type?: string } | null;
      if (body?.type === "ApproveEdits") {
        approvals += 1;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
          body: JSON.stringify({
            detail:
              "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine.",
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/transcript/refine/waive", async (route) => {
      const body = route.request().postDataJSON() as { reason?: string };
      waiverReason = body.reason ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });
    await openSuggestedPendingEdit(page, projectPath);
    const inspector = page
      .locator(".modifier-inspector")
      .filter({ has: page.getByRole("heading", { name: "Pending edit" }) });
    await inspector
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Cut anyway" }),
    ).toBeVisible();
    await expect(page.getByText(/Cut anyway, or check it first/)).toBeVisible();
    await expect(
      page
        .locator(".modifier-inspector")
        .filter({ has: page.getByRole("heading", { name: "Pending edit" }) })
        .getByText(/Run podcast-transcript-refine/),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Waiver reason" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Cut anyway" }).click();
    await expect(
      page.getByText("Waiver recorded. Retry approval to apply pending edits."),
    ).toBeVisible();
    expect(waiverReason).toBe("Cut anyway, chosen by the host");
    expect(approvals).toBe(1);
  });
});
