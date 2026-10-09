import { test } from "@playwright/test";
import {
  checkMixGeometry,
  checkNativeMixEdits,
  openPhoneMix,
} from "../e2e/phoneMix";
import { checkPhoneMixFocus } from "../e2e/phoneMixFocus";
import { withShareableProject } from "../e2e/shareableProject";

test("phone Mix native edits and touch geometry across engines", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await checkNativeMixEdits(page, projectPath);
    await openPhoneMix(page);
    await checkMixGeometry(page, info);
  });
  await checkPhoneMixFocus(page, info);
});
