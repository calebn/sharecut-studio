import { expect, test } from "@playwright/test";
import { parseWavHeader } from "../src/audio/wavHeader";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath, e2eUrl } from "./env";

/**
 * RMS of the reference track stem in `[startSec, endSec)`, rebuilt fresh
 * (`rerender=true`) so an ignore/restore is reflected immediately.
 */
async function stemRms(
  request: import("@playwright/test").APIRequestContext,
  startSec: number,
  endSec: number,
): Promise<number> {
  const url =
    `${e2eUrl()}/api/audio?path=${encodeURIComponent(e2eProjectPath)}` +
    "&kind=stem&track_id=reference&rerender=true";
  const res = await request.get(url);
  expect(res.ok()).toBe(true);
  const buffer = await res.body();
  const header = parseWavHeader(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  const bytesPerSample = header.bitsPerSample / 8;
  const startFrame = Math.floor(startSec * header.sampleRate);
  const endFrame = Math.ceil(endSec * header.sampleRate);
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + header.dataOffset,
    header.dataSize,
  );
  let sumSquares = 0;
  let count = 0;
  for (let frame = startFrame; frame < endFrame; frame++) {
    const offset = frame * header.blockAlign;
    if (offset + bytesPerSample > header.dataSize) {
      break;
    }
    const sample =
      header.bitsPerSample === 16
        ? view.getInt16(offset, true) / 32768
        : view.getFloat32(offset, true);
    sumSquares += sample * sample;
    count += 1;
  }
  return count > 0 ? Math.sqrt(sumSquares / count) : 0;
}

test.describe("Transcript ignore mutes the stem; restore brings it back (#633)", () => {
  test("ignore mutes the word span at render, restore un-mutes it", async ({
    page,
    request,
  }) => {
    const baseline = await stemRms(request, 2.35, 2.55);
    expect(baseline).toBeGreaterThan(0.1);

    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    await page
      .getByLabel("Editor panels")
      .getByRole("button", { name: "Transcript", exact: true })
      .click();
    await page.getByRole("button", { name: /^Select:/ }).click();

    const list = page.locator(".transcript-list");
    const to = list.getByRole("button", { name: "to", exact: true }).first();
    const the = list.getByRole("button", { name: "the", exact: true }).first();
    const show = list
      .getByRole("button", { name: "show", exact: true })
      .first();
    // `to` already resolves via `.first()`; filtering `.utterance-turn` on
    // `{ has: to }` is unreliable per the Playwright docs (a `has` locator
    // must not itself use `.first()`/`.last()`/`.nth()`) and hangs
    // indefinitely. Walk up from the resolved `to` element instead.
    const turn = to
      .locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' utterance-turn ')]",
      )
      .first();

    let restored = false;
    try {
      await to.click();
      await the.click({ modifiers: ["Shift"] });
      const showBefore = await show.boundingBox();
      const turnBefore = await turn.boundingBox();

      const commands: string[] = [];
      page.on("request", (req) => {
        if (
          req.url().includes("/api/document/command") &&
          req.method() === "POST"
        ) {
          const type = (req.postDataJSON() as { type?: string } | null)?.type;
          if (type) commands.push(type);
        }
      });

      await page.getByRole("button", { name: /^Ignore:/ }).click();
      await expect(async () => {
        expect(commands).toContain("SetTranscriptWordsIgnored");
      }).toPass();
      await expect(to).toHaveClass(/ignored/);
      await expect(the).toHaveClass(/ignored/);
      // The hidden Restore control reserves no space (#672 review).
      await page.mouse.move(0, 0);
      const showAfter = await show.boundingBox();
      const turnAfter = await turn.boundingBox();
      expect(Math.abs((showAfter?.x ?? 0) - (showBefore?.x ?? 0))).toBeLessThan(
        1,
      );
      expect(
        Math.abs((turnAfter?.height ?? 0) - (turnBefore?.height ?? 0)),
      ).toBeLessThan(1);

      // Restore follows its run when the list scrolls: its containing block
      // (the run's last-word wrapper) is inside the scroller (#672 review).
      const theHandle = await the.elementHandle();
      const geometry = await list.evaluate((el, word) => {
        const restore = el.querySelector<HTMLElement>(
          '[aria-label="Restore ignored: to the"]',
        );
        if (!restore || !word) {
          return null;
        }
        const spacer = document.createElement("div");
        spacer.style.flex = "none";
        spacer.style.height = "200vh";
        el.append(spacer);
        el.scrollTop = 80;
        const scrolled = el.scrollTop;
        const w = (word as HTMLElement).getBoundingClientRect();
        const b = restore.getBoundingClientRect();
        el.scrollTop = 0;
        spacer.remove();
        return {
          scrolled,
          wordRight: w.right,
          wordBottom: w.bottom,
          wordHeight: w.height,
          buttonRight: b.right,
          buttonTop: b.top,
        };
      }, theHandle);
      expect(geometry).not.toBeNull();
      expect(geometry?.scrolled ?? 0).toBeGreaterThan(0);
      // Hangs just below the run's last word, right-aligned to it.
      expect(
        Math.abs((geometry?.buttonRight ?? 0) - (geometry?.wordRight ?? 0)),
      ).toBeLessThan(16);
      expect(
        Math.abs((geometry?.buttonTop ?? 0) - (geometry?.wordBottom ?? 0)),
      ).toBeLessThan(geometry?.wordHeight ?? 0);

      // A run ending at a line end must not widen the list (#672 review).
      // "the" is 2-3 short words into its turn, nowhere near the line end
      // at the list's natural width, so a percentage-based narrowing (e.g.
      // shaving the list down to 60% of its width) never reaches a line
      // break there. Compute the exact width that puts "the" right at the
      // wrapped line's end instead: just enough room for the text through
      // "the" and no more (so the next word wraps to the following line).
      const overflow = await list.evaluate((el, word) => {
        const target = word as HTMLElement | null;
        const restore = el.querySelector<HTMLElement>(
          '[aria-label="Restore ignored: to the"]',
        );
        if (!restore || !target) {
          return null;
        }
        const originalWidth = el.style.width;
        const originalFlex = el.style.flex;
        el.style.flex = "none";
        const listLeft = el.getBoundingClientRect().left + el.clientLeft;
        const wordRight = target.getBoundingClientRect().right;
        // +1px so "the" itself still fits; anything past it must wrap.
        const targetWidth = Math.ceil(wordRight - listLeft) + 1;
        el.style.width = `${targetWidth}px`;
        restore.style.display = "none";
        const without = el.scrollWidth - el.clientWidth;
        restore.style.display = "";
        const extra = el.scrollWidth - el.clientWidth - without;
        const listRight =
          el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
        const nearestGap = Math.max(
          0,
          listRight - target.getBoundingClientRect().right,
        );
        el.style.width = originalWidth;
        el.style.flex = originalFlex;
        return { extra, nearestGap };
      }, theHandle);
      expect(overflow).not.toBeNull();
      expect(overflow?.nearestGap ?? Number.POSITIVE_INFINITY).toBeLessThan(8);
      expect(overflow?.extra ?? 1).toBe(0);
      restored = false;

      const mutedRms = await stemRms(request, 2.35, 2.55);
      expect(mutedRms).toBeLessThan(baseline * 0.01);

      await expectPageAxeClean(page, ".transcript-panel");

      await the.hover();
      const restoreControl = page.getByRole("button", {
        name: /^Restore ignored: to the$/,
      });
      await restoreControl.click();
      restored = true;

      await expect(to).not.toHaveClass(/ignored/);
      await expect(the).not.toHaveClass(/ignored/);

      const restoredRms = await stemRms(request, 2.35, 2.55);
      expect(restoredRms).toBeGreaterThan(baseline * 0.5);
    } finally {
      if (!restored) {
        await page.request.post(
          `/api/document/command?path=${encodeURIComponent(e2eProjectPath)}`,
          {
            data: {
              type: "SetTranscriptWordsIgnored",
              payload: {
                track_id: "reference",
                start_word_index: 1,
                end_word_index: 2,
                ignored: false,
              },
              client_id: "e2e-ignore-cleanup",
              role: "viewer",
            },
          },
        );
      }
    }
  });
});
