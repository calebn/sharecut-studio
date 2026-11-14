import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  anchoringOff,
  BODY,
  bodyOverflows,
  expectNoBlankFrame,
  frames,
  placeInView,
  SECTION,
  SHORT_PHONE,
  scrollByHand,
  scrollIdle,
  visiblePlace,
  WORD,
  withGuest,
} from "../e2e/guestTranscript";

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
      await view.locator(WORD).first().click();
      // Not at the end: a browser clamping the scroll to a shorter page would
      // move the word, so only restoring the reader's place keeps it still.
      const { over } = await bodyOverflows(body);
      const target = over - 60;
      await scrollByHand(view, target);
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

async function followerHoldsStill(
  browser: Browser,
  page: Page,
  mode: "paused" | "playing",
) {
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
        await expect(view.locator(`${WORD}[data-playing]`).first()).toHaveCount(
          1,
          { timeout: 10_000 },
        );
      }
      await scrollIdle(view);
      const anchorKey = await visiblePlace(view, "first");
      expect(anchorKey, "a word is visible to anchor on").not.toBeNull();
      guest.detail.delayMs = 1_500;
      const seen = await frames(guest, page, "cut", 1, anchorKey, 0.5);
      expectNoBlankFrame(seen.frames, seen.from, guest.log, "for a follower");
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
}

test("a following guest, paused, keeps its view still while the Script refreshes", async ({
  browser,
  page,
}) => {
  await followerHoldsStill(browser, page, "paused");
});

test("a following guest, playing, keeps its view still while the Script refreshes", async ({
  browser,
  page,
}) => {
  await followerHoldsStill(browser, page, "playing");
});

test("a following guest holds its view still through a second refresh, wherever the playhead went", async ({
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
      await anchoringOff(view);
      await view.locator(WORD).nth(-26).click();
      await expect
        .poll(async () => (await bodyOverflows(body)).over)
        .toBeGreaterThan(100);
      guest.detail.delayMs = 1_000;
      const firstCut = await frames(
        guest,
        page,
        "cut",
        1,
        await visiblePlace(view, "first"),
        0.5,
      );
      await expect(view.locator(SECTION)).not.toHaveAttribute(
        "aria-busy",
        "true",
      );
      // The playhead goes well down the transcript, and the follow with it.
      await view.locator(WORD).nth(-3).click();
      await scrollIdle(view);
      const place = await visiblePlace(view, "first");
      expect(place, "a word is visible to anchor on").not.toBeNull();
      // A correction: the line changes but nothing is removed, so the pane can hold its place.
      const secondCut = await frames(guest, page, "correct", 1, place);
      for (const [name, seen] of [
        ["first", firstCut],
        ["second", secondCut],
      ] as const) {
        const after = seen.frames.filter((f) => f.t >= seen.from);
        const offsets = after.map((f) => f.offset);
        expect(
          offsets.every((o) => o !== null),
          `the ${name} refresh kept the word the follower looked at`,
        ).toBe(true);
        const start = offsets[0] as number;
        expect(
          Math.max(...offsets.map((o) => Math.abs((o as number) - start))),
          `the follower's view moved in the ${name} refresh`,
        ).toBeLessThan(2);
      }
    },
  );
});
