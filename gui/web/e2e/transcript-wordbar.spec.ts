import { test } from "@playwright/test";
import { newFinger } from "./finger";
import {
  checkWordbarInterruptsEndTouchDrag,
  checkWordbarOutsideRelease,
} from "./wordbarFlow";

test("Wordbar handle drag saves once outside the inspector and Undo restores exact timing", async ({
  page,
}) => {
  await checkWordbarOutsideRelease(page);
});

test.describe("touch", () => {
  test.use({ hasTouch: true });

  test("A blur or a width rotation mid-drag saves nothing and a normal touch drag saves once", async ({
    page,
    context,
    browserName,
  }) => {
    const finger = await newFinger(context, page, browserName);
    await checkWordbarInterruptsEndTouchDrag(page, finger);
  });
});
