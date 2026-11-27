import { test } from "@playwright/test";
import { newFinger } from "./finger";
import { checkWordbarInterruptsEndTouchDrag } from "./wordbarFlow";

test.use({ hasTouch: true });

test("A blur or a width rotation mid-drag saves nothing and a normal touch drag saves once", async ({
  page,
  context,
  browserName,
}) => {
  const finger = await newFinger(context, page, browserName);
  await checkWordbarInterruptsEndTouchDrag(page, finger);
});
