import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("Sharecut Studio smoke", () => {
  test("loads fixture project shell and is axe-clean on chrome", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(
      page
        .getByLabel("Editor panels")
        .getByRole("button", { name: "Transcript", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByLabel("Editor panels")
        .getByRole("button", { name: "Comments" }),
    ).toBeVisible();
    await expect(page.locator(".daw-shell")).toBeVisible();

    await expectPageAxeClean(page);
  });

  test("opens the host Tighten panel (aligned_dialogue has no filler hits)", async ({
    page,
  }) => {
    // aligned_dialogue ships empty editorial.edit_decisions — no fixture helper
    // seeds filler:/pause: pending rows, so this is open + empty-state only.
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const panels = page.getByLabel("Editor panels");
    await panels.getByRole("button", { name: "Tighten", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tighten" })).toBeVisible();
    await expect(
      page.getByText("No pending filler or pause decisions."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Apply eligible/ }),
    ).toBeDisabled();
  });
});
