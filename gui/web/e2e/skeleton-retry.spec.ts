import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test("a slow host Script load keeps its status without offering a Retry it cannot perform", async ({
  page,
}) => {
  await page.routeWebSocket(/\/api\/host\/ws/, () => undefined);
  await page.route(
    (url) => new URL(url).pathname === "/api/document/state",
    () => {},
  );
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`, {
    waitUntil: "commit",
  });

  const script = page.getByRole("region", { name: "Script", exact: true });
  await expect(script.getByRole("status")).toHaveText("Still loading…");
  await expect(script.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expectPageAxeClean(page);
});
