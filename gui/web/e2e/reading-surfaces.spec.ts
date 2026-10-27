import { test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { openHome } from "./home";

test.describe("reading surfaces", () => {
  test("Home without a project is axe-clean including contrast", async ({
    page,
  }) => {
    await openHome(page);
    await expectReadingSurfaceAxeClean(page);
  });
});
