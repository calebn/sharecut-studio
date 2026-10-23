import { expect, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 375, height: 667 },
});

test("phone navigation exposes its scoped touch policy and activates on taps", async ({
  page,
}) => {
  await openHostProject(page);
  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("button")).toHaveCount(4);
  for (const label of ["Listen", "Timeline", "Text", "More"]) {
    const button = navigation.getByRole("button", {
      name: label,
      exact: true,
    });
    await expect(button).toHaveCSS("touch-action", "manipulation");
    await button.tap();
    await button.tap();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  for (const selector of ["html", "body", ".daw-shell", ".mobile-nav"]) {
    await expect(page.locator(selector)).toHaveCSS("touch-action", "auto");
  }
});
