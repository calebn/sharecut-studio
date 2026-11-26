import { expect, test } from "@playwright/test";
import { storyUrl } from "./storyUrl";

/**
 * #2919: in the real Edit timeline (Templates/Timeline, the sticky ruler and the
 * separate presence window) a ruler label paints over a remote presence flag.
 * jsdom has no layout, so the stacking is measured with real hit-testing.
 */
for (const width of [900, 390]) {
  test(`Templates/Timeline ruler labels paint over the remote flag at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 400 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(
      storyUrl("templates-timeline--remote-flags-over-ruler-labels", {
        theme: "light",
      }),
    );
    await page.waitForSelector(".sys-presence-flag");
    // The layers take no pointer, so elementFromPoint would skip them. Let
    // them be hit: it changes no stacking, so the hit is the topmost paint.
    await page.addStyleTag({
      content:
        ".timeline-presence-window, .timeline-presence-window *, .timeline-ruler-labels .sys-ruler-tick { pointer-events: auto !important; }",
    });

    const result = await page.evaluate(() => {
      const flags = [...document.querySelectorAll(".sys-presence-flag")].map(
        (flag) => ({
          el: flag,
          box: flag.getBoundingClientRect(),
          visibility: getComputedStyle(flag).visibility,
        }),
      );
      const labels = [
        ...document.querySelectorAll<HTMLElement>(".sys-ruler-tick"),
      ]
        .filter((tick) => (tick.textContent ?? "").trim() !== "")
        .map((tick) => {
          const range = document.createRange();
          range.selectNodeContents(tick);
          return {
            tick,
            text: tick.textContent ?? "",
            box: range.getBoundingClientRect(),
          };
        });
      // Sample the centre of each place where a flag lies over label text.
      const samples = labels.flatMap((label) =>
        flags.flatMap((flag) => {
          const left = Math.max(label.box.left, flag.box.left);
          const right = Math.min(label.box.right, flag.box.right);
          const top = Math.max(label.box.top, flag.box.top);
          const bottom = Math.min(label.box.bottom, flag.box.bottom);
          if (left >= right || top >= bottom) return [];
          const hit = document.elementFromPoint(
            (left + right) / 2,
            (top + bottom) / 2,
          );
          return [
            {
              text: label.text.trim(),
              hitFlag: hit?.closest(".sys-presence-flag") != null,
              hitLabel: hit != null && label.tick.contains(hit),
              hitClass: hit?.className ?? null,
            },
          ];
        }),
      );
      // The flag's lower edge is clear of the label text: it must still be drawn.
      const flagsShown = flags.filter((flag) => {
        const hit = document.elementFromPoint(
          (flag.box.left + flag.box.right) / 2,
          flag.box.bottom - 2,
        );
        return hit != null && flag.el.contains(hit);
      }).length;
      return {
        flagsShown,
        flags: flags.map((flag) => ({
          visibility: flag.visibility,
          width: flag.box.width,
          height: flag.box.height,
        })),
        samples,
      };
    });

    expect(result.flags.length).toBeGreaterThanOrEqual(3);
    for (const flag of result.flags) {
      expect(flag.visibility).toBe("visible");
      expect(flag.width).toBeGreaterThan(0);
      expect(flag.height).toBeGreaterThan(0);
    }
    expect(result.flagsShown).toBeGreaterThanOrEqual(1);
    // The story must really put flags over at least two labels.
    const covered = new Set(result.samples.map((sample) => sample.text));
    expect(covered.size).toBeGreaterThanOrEqual(2);
    for (const sample of result.samples) {
      expect(
        sample.hitLabel,
        `${sample.text} text is covered by ${sample.hitClass}`,
      ).toBe(true);
      expect(sample.hitFlag, `${sample.text} is covered by the flag`).toBe(
        false,
      );
    }
  });
}
