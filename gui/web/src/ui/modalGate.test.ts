import { afterEach, describe, expect, it } from "vitest";
import {
  closeOverlay,
  isInnermostOverlay,
  openOverlay,
  overlayOpen,
} from "./modalGate";

describe("modalGate stack rank", () => {
  const layers: ReturnType<typeof openOverlay>[] = [];
  afterEach(() => {
    for (const layer of layers.splice(0)) closeOverlay(layer);
  });

  it("keeps a later popover innermost when a keyed sheet remounts", () => {
    const sheet = openOverlay(false, [], () => undefined, "inspector");
    layers.push(sheet);
    const popover = openOverlay(false);
    layers.push(popover);
    expect(isInnermostOverlay(popover)).toBe(true);

    closeOverlay(sheet);
    const remounted = openOverlay(false, [], () => undefined, "inspector");
    layers.push(remounted);

    expect(isInnermostOverlay(popover)).toBe(true);
    expect(isInnermostOverlay(remounted)).toBe(false);
    expect(overlayOpen()).toBe(true);
  });

  it("keeps a modal innermost over a remounted sheet", () => {
    const sheet = openOverlay(false, [], () => undefined, "inspector");
    layers.push(sheet);
    const modal = openOverlay(true);
    layers.push(modal);
    closeOverlay(sheet);
    const remounted = openOverlay(false, [], () => undefined, "inspector");
    layers.push(remounted);
    expect(isInnermostOverlay(modal)).toBe(true);
    expect(isInnermostOverlay(remounted)).toBe(false);
  });
});
