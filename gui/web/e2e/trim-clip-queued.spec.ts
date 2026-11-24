import { test } from "@playwright/test";
import { expectQueuedTrimHoldsUntilItSyncs } from "./queuedTrim";

test("a clip trim that queues offline stays where it was put, then saves once online", async ({
  page,
}) => {
  await expectQueuedTrimHoldsUntilItSyncs(page);
});
