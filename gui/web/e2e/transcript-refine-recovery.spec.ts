import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

test("host can waive a blocked approval in the browser", async ({ page }) => {
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
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await page.getByRole("button", { name: "Suggest cut" }).click();
  const panels = page.getByLabel("Editor panels");
  await panels.getByRole("button", { name: "Impact" }).click();
  await panels
    .getByRole("button", { name: /guest:suggest/ })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Pending edit" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Waive with reason" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Review the transcript or waive with a reason below/),
  ).toBeVisible();
  await expect(page.getByText(/Run podcast-transcript-refine/)).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Waiver reason" })
    .fill("Reviewed transcript");
  await page.getByRole("button", { name: "Waive with reason" }).click();
  await expect(
    page.getByText("Waiver recorded. Retry approval to apply pending edits."),
  ).toBeVisible();
  expect(waiverReason).toBe("Reviewed transcript");
  expect(approvals).toBe(1);
});
