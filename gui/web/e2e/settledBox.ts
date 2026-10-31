import { expect, type Locator } from "@playwright/test";

export type Box = { x: number; y: number; width: number; height: number };

export async function settledBox(locator: Locator): Promise<Box> {
  let last: Box | null = null;
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
  if (last == null) throw new Error("box settled without a read");
  return last;
}
