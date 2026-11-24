import { test } from "@playwright/test";
import {
  expectQueuedTrimHoldsUntilItSyncs,
  expectSecondTrimWaitsForTheQueuedOne,
} from "./queuedTrim";

test("a clip trim that queues offline stays where it was put, then saves once online", async ({
  page,
}) => {
  await expectQueuedTrimHoldsUntilItSyncs(page);
});

test("a second trim of a clip whose first trim is queued waits for it", async ({
  page,
}) => {
  await expectSecondTrimWaitsForTheQueuedOne(page);
});
