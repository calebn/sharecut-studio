import { test } from "@playwright/test";
import {
  expectQueuedTrimHoldsUntilItSyncs,
  expectSecondTrimWaitsForTheQueuedOne,
} from "../e2e/queuedTrim";

test("a clip trim that queues offline stays where it was put in every engine", async ({
  page,
}) => {
  await expectQueuedTrimHoldsUntilItSyncs(page);
});

test("a second trim of a clip whose first trim is queued waits for it in every engine", async ({
  page,
}) => {
  await expectSecondTrimWaitsForTheQueuedOne(page);
});
