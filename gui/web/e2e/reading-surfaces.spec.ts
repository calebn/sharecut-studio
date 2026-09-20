import { expect, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";

test.describe("reading surfaces", () => {
  test("HomeScreen without a project is axe-clean including contrast", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("sharecut.bootstrap.skip", "1");
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /^Sharecut Studio$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New project…" }),
    ).toBeVisible();
    await expectReadingSurfaceAxeClean(page);
  });
});
