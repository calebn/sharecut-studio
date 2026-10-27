import { test } from "@playwright/test";
import {
  checkMixGeometry,
  checkNativeMixEdits,
  openPhoneMix,
} from "../e2e/phoneMix";
import { checkPhoneMixFocus } from "../e2e/phoneMixFocus";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";

test("phone Mix native edits and touch geometry across engines", async ({
  page,
  browserName,
}, info) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await checkNativeMixEdits(page, projectPath);
    await openPhoneMix(page);
    await checkMixGeometry(page, info, {
      suite: "compat",
      engine: browserName,
    });
  });
  await checkPhoneMixFocus(
    page,
    info,
    browserName === "webkit" ? "Alt+Tab" : "Tab",
  );
});
