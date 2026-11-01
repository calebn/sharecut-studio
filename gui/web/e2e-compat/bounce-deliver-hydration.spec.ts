import { test } from "@playwright/test";
import { exerciseBounceHydration } from "../e2e/bounceHydration";

test("Bounce remains reachable through running-row insertion and late Transcript hydration", async ({
  page,
}, info) => {
  await exerciseBounceHydration(page, info, false);
});

test("Deliver restores normal reading after departure from a starting Bounce", async ({
  page,
}, info) => {
  await exerciseBounceHydration(page, info, true);
});
