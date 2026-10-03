import { test } from "@playwright/test";
import { exerciseEnvelopeRecovery } from "../e2e/envelopeRecovery";

test("native envelope owner cancels locally and ignores synthetic foreign events", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await exerciseEnvelopeRecovery(page, "dark", info);
});
