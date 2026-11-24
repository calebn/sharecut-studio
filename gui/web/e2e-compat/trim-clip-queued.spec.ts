import { test } from "@playwright/test";
import { expectQueuedTrimHoldsUntilItSyncs } from "../e2e/queuedTrim";

test("a clip trim that queues offline stays where it was put in every engine", async ({
  page,
}) => {
  await expectQueuedTrimHoldsUntilItSyncs(page);
});
