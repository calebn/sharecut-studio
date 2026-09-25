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
    const measured = await list.evaluate((element: HTMLElement, key) => {
      const horizontal = key === "scrollLeft";
      element[key] = horizontal ? element.scrollWidth : element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
      const size = horizontal ? element.scrollWidth : element.scrollHeight;
      const client = horizontal ? element.clientWidth : element.clientHeight;
      const at = element[key];
      // Width the scrollbar takes from the scrolled axis's client box. On a
      // classic-scrollbar platform (Linux CI), `scrollbar-gutter: stable` reserves
      // the vertical scrollbar's width in clientWidth even when nothing scrolls
      // vertically, yet Chromium's maximum horizontal offset ignores it, so that
      // width stays unreachable however far the content extends.
      const reserved = horizontal
        ? element.offsetWidth - element.clientWidth - 2 * element.clientLeft
        : element.offsetHeight - element.clientHeight - 2 * element.clientTop;
      return {
        gap: size - (at + client),
        size,
        client,
        at,
        reserved: Math.max(0, reserved),
      };
    }, axis);
    expect(measured.gap, JSON.stringify(measured)).toBeLessThanOrEqual(
      END_SLACK_PX + measured.reserved,
    );
  }).toPass({ timeout });
}
