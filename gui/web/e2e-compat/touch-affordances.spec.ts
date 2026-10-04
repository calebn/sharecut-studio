import { test } from "@playwright/test";
import { exerciseTouchSheetAffordances } from "../e2e/touchAffordances";

test("actual sheet controls and help copy work in the compatibility browser", async ({
  page,
}) => {
  await exerciseTouchSheetAffordances(
    page,
    { width: 390, height: 844, sheetExpected: true },
    "dark",
    true,
  );
});
