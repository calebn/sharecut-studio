import { expect, type Locator } from "@playwright/test";

/**
 * Scroll `list` to the end of `axis` and wait until the end is reachable.
 * Each probe re-applies the scroll: a later write by the app, or a client box
 * that changes after the first write, can leave the old position short of it.
 */
export async function scrollToEnd(
  list: Locator,
  axis: "scrollLeft" | "scrollTop",
  timeout = 10_000,
): Promise<void> {
  await expect(async () => {
    await list.evaluate((element, key) => {
      element[key] =
        key === "scrollLeft" ? element.scrollWidth : element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    }, axis);
    const reached = await list.evaluate(
      (element, key) =>
        key === "scrollLeft"
          ? element.scrollLeft + element.clientWidth >= element.scrollWidth - 1
          : element.scrollTop + element.clientHeight >=
            element.scrollHeight - 1,
      axis,
    );
    expect(reached).toBe(true);
  }).toPass({ timeout });
}
