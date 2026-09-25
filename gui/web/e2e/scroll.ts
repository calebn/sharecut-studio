import { expect, type Locator } from "@playwright/test";

/**
 * Slack for the end check. scrollWidth/clientWidth are rounded integers while
 * the real maximum scroll offset is fractional, so at very large content
 * (15 M px) the reachable offset can fall a pixel or two short of the rounded end.
 */
const END_SLACK_PX = 2;

/**
 * Scroll `list` to the end of `axis` and wait until the end is reachable.
 * Each probe re-applies the scroll: a later write by the app, or a client box
 * that changes after the first write, can leave the old position short of it.
 * A failure reports the measured offsets.
 */
export async function scrollToEnd(
  list: Locator,
  axis: "scrollLeft" | "scrollTop",
  timeout = 10_000,
): Promise<void> {
  await expect(async () => {
    const measured = await list.evaluate((element, key) => {
      const horizontal = key === "scrollLeft";
      element[key] = horizontal ? element.scrollWidth : element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
      const size = horizontal ? element.scrollWidth : element.scrollHeight;
      const client = horizontal ? element.clientWidth : element.clientHeight;
      const at = element[key];
      return { gap: size - (at + client), size, client, at };
    }, axis);
    expect(measured.gap, JSON.stringify(measured)).toBeLessThanOrEqual(
      END_SLACK_PX,
    );
  }).toPass({ timeout });
}
