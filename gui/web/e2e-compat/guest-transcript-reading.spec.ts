import { expect, test } from "@playwright/test";
import {
  anchoringOff,
  BODY,
  bodyOverflows,
  expectNoBlankFrame,
  frames,
  placeInView,
  SHORT_PHONE,
  scrollByHand,
  visiblePlace,
  WORD,
  withGuest,
} from "../e2e/guestTranscript";

/**
 * A guest who is reading, or following, keeps their place while the host's
 * edit makes the Script refresh. Scroll anchoring is off, so the page's own
 * code has to do it, in Chromium and in WebKit.
 */

test("a scrolled reader's word stays where it was through a host cut above it", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "viewer", size: SHORT_PHONE },
    async (guest) => {
      const { page: view } = guest;
      const body = view.locator(BODY);
      expect(
        (await bodyOverflows(body)).over,
        "the Script must overflow to scroll",
      ).toBeGreaterThan(100);
      await anchoringOff(view);
      // The playhead sits on the first word, so the pane has a place to go back to.
      await view.locator(WORD).first().click();
      // Not at the end: when the lines above shrink, a browser that clamps the
      // scroll to the shorter page would move the word, so only restoring the
      // reader's place keeps it still.
      const { over } = await bodyOverflows(body);
      const target = over - 60;
      await scrollByHand(view, target);
      // The pane took it for the reader's: follow is off.
      await expect(
        view.getByRole("button", { name: "Back to playhead" }),
      ).toBeVisible();
      await expect
        .poll(async () => body.evaluate((el) => el.scrollTop))
        .toBe(target);
      const anchorKey = await visiblePlace(view, "first");
      expect(anchorKey, "a word is visible to anchor on").not.toBeNull();

      const seen = await frames(guest, page, "cut", 1, anchorKey, 0.5);
      expectNoBlankFrame(
        seen.frames,
        seen.from,
        guest.log,
        "for a scrolled reader",
      );
      const offsets = seen.frames
        .filter((f) => f.t >= seen.from)
        .map((f) => f.offset);
      expect(
        offsets.every((o) => o !== null),
        "the reader's word stayed on screen",
      ).toBe(true);
      const first = offsets[0] as number;
      const worst = Math.max(
        ...offsets.map((o) => Math.abs((o as number) - first)),
      );
      expect(
        worst,
        "the reader's word moved by at most 2px on every frame",
      ).toBeLessThan(2);
    },
  );
});

for (const mode of ["paused", "playing"] as const) {
  test(`a following guest, ${mode}, keeps its view still while the Script refreshes`, async ({
    browser,
    page,
  }) => {
    await withGuest(
      browser,
      page,
      { role: "viewer", size: SHORT_PHONE },
      async (guest) => {
        const { page: view } = guest;
        const body = view.locator(BODY);
        expect(
          (await bodyOverflows(body)).over,
          "the Script must overflow to scroll",
        ).toBeGreaterThan(100);
        await anchoringOff(view);
        // A tap on a late word moves the playhead there; following scrolls to it.
        const tapped = view.locator(WORD).nth(-26);
        const playheadPlace = await tapped.evaluate((el) => {
          const turn = el.closest("[data-turn-id]");
          const nth = [
            ...(turn?.querySelectorAll("[data-word-key]") ?? []),
          ].indexOf(el);
          return `${turn?.getAttribute("data-turn-id")}|${nth}`;
        });
        await tapped.click();
        await expect
          .poll(async () => (await bodyOverflows(body)).over)
          .toBeGreaterThan(100);
        if (mode === "playing") {
          await view.getByRole("button", { name: "Play", exact: true }).click();
          await expect(
            view.locator(`${WORD}[data-playing]`).first(),
          ).toHaveCount(1, { timeout: 10_000 });
        }
        await view.waitForTimeout(400);
        const anchorKey = await visiblePlace(view, "first");
        expect(anchorKey, "a word is visible to anchor on").not.toBeNull();
        guest.detail.delayMs = 1_500;
        const seen = await frames(guest, page, "cut", 1, anchorKey, 0.5);
        expectNoBlankFrame(seen.frames, seen.from, guest.log, "for a follower");
        // Every frame from the edit on, the delta and the swap included.
        const after = seen.frames.filter((f) => f.t >= seen.from);
        expect(after.some((f) => f.busy)).toBe(true);
        const offsets = after.map((f) => f.offset);
        expect(
          offsets.every((o) => o !== null),
          "the word the follower was looking at stayed drawn",
        ).toBe(true);
        const first = offsets[0] as number;
        expect(
          Math.max(...offsets.map((o) => Math.abs((o as number) - first))),
          "the follower's view moved while the Script refreshed",
        ).toBeLessThan(2);
        const playing = view.locator(`${WORD}[data-playing]`).first();
        if (mode === "playing")
          await expect(playing, "the playing word is in view").toBeInViewport();
        else
          expect(
            await placeInView(view, playheadPlace),
            "the word at the playhead is in view",
          ).toBe(true);
      },
    );
  });
}
