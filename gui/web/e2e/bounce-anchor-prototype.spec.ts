import { test } from "@playwright/test";
import { recordBounceAnchorPrototype } from "./bounceAnchorPrototype";

test("static Bounce anchoring experiment records reachability and user navigation", async ({
  page,
  browser,
  browserName,
}, info) => {
  await recordBounceAnchorPrototype(page, browserName, browser.version(), info);
});
