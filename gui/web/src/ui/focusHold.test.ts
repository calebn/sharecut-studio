import { expect, it } from "vitest";
import { focusHeld, registerFocusHold } from "./focusHold";

it("keeps another registration of the same predicate when one unregisters", () => {
  const held = () => true;
  const releaseFirst = registerFocusHold(held);
  const releaseSecond = registerFocusHold(held);
  releaseFirst();
  expect(focusHeld(document)).toBe(true);
  releaseSecond();
  expect(focusHeld(document)).toBe(false);
});
