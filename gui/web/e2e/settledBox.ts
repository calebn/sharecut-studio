import { expect, type Locator } from "@playwright/test";

export type Box = { x: number; y: number; width: number; height: number };

/** Rotation remounts the timeline; waits for a layout that has stopped moving. Call after asserting the target arrangement. */
export async function settledBox(locator: Locator): Promise<Box> {
  let last = null as Box | null;
  try {
    await expect
      .poll(
        async () => {
          const now = await locator.boundingBox();
          const same =
            now != null &&
            last != null &&
            now.x === last.x &&
            now.y === last.y &&
            now.width === last.width &&
            now.height === last.height;
          last = now;
          return same;
        },
        { message: "box never settled" },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(`box never settled; last seen ${JSON.stringify(last)}`, {
      cause: error,
    });
  }
  if (last == null) throw new Error("box settled without a read");
  return last;
}
