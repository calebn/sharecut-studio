import { expect, type Page, test } from "@playwright/test";
import {
  expectNoBlankFrame,
  frames,
  hostEdit,
  REASON,
  ROLES,
  SECTION,
  SIZES,
  startWatch,
  stopWatch,
  type Watched,
  WIDE,
  WORD,
  withGuest,
} from "./guestTranscript";
import { parseTimecodeSec } from "./timecode";

/**
 * A guest reading the transcript keeps its words on screen while the host
 * edits. The host edit is a real document command posted to the host API; the
 * guest receives it as a word-free delta over the review socket and then
 * refetches the word detail. A frame watcher records every animation frame and
 * DOM mutation so a gap of a few milliseconds cannot slip between polls.
 */

for (const role of ROLES) {
  for (const size of SIZES) {
    test(`a ${role} at ${size.width}x${size.height} keeps the transcript on screen through a host cut`, async ({
      browser,
      page,
    }) => {
      await withGuest(browser, page, { role, size }, async (guest) => {
        const seen = await frames(guest, page, "cut", 1);
        expectNoBlankFrame(
          seen.frames,
          seen.from,
          guest.log,
          "after a host cut",
        );
      });
    });
  }
}

test("a commenter keeps the transcript on screen through a host correction", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "commenter", size: WIDE },
    async (guest) => {
      const seen = await frames(guest, page, "correct", 1);
      expectNoBlankFrame(
        seen.frames,
        seen.from,
        guest.log,
        "after a host correction",
      );
    },
  );
});

test("a commenter keeps the transcript on screen through two quick host cuts", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "commenter", size: WIDE },
    async (guest) => {
      const seen = await frames(guest, page, "cut", 2);
      expectNoBlankFrame(
        seen.frames,
        seen.from,
        guest.log,
        "after two quick host cuts",
      );
    },
  );
});

const clock = (page: Page) => page.locator(".sys-player-now");
const seconds = async (page: Page) =>
  parseTimecodeSec(await clock(page).innerText());

test("a slow word detail leaves the same busy Script, whose held words do not seek", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "commenter", size: WIDE },
    async (guest) => {
      const { page: view } = guest;
      const section = view.locator(SECTION);
      const last = view.locator(WORD).last();
      // A selection made before the edit is the one the bar acts on: a gesture
      // on a held word is dropped, because a cut renumbers the words.
      await last.click();
      await expect(
        view.getByRole("group", { name: "Selection actions" }),
      ).toBeVisible();
      const before = await seconds(view);
      const { from } = await startWatch(view);
      guest.detail.delayMs = 1_500;
      await hostEdit(page, guest.projectPath, "cut", 0);

      await expect(section).toHaveAttribute("aria-busy", "true", {
        timeout: 10_000,
      });
      expect(
        await view.evaluate(
          (selector) =>
            document.querySelector(selector) ===
            (window as unknown as Watched).__scriptSection,
          SECTION,
        ),
        "the Script section is the element that was on screen before the edit",
      ).toBe(true);
      expect(await view.locator(WORD).count()).toBeGreaterThan(0);

      await view.locator(WORD).first().click();
      await view.waitForTimeout(300);
      expect(await seconds(view), "a tap on a held word does not seek").toBe(
        before,
      );
      const bar = view.getByRole("group", { name: "Selection actions" });
      await expect(bar).toBeVisible();
      const comment = bar.getByRole("button", { name: "Comment" });
      await expect(comment).toBeDisabled();
      await expect(comment).toHaveAttribute("title", REASON);

      await expect(section).not.toHaveAttribute("aria-busy", "true", {
        timeout: 15_000,
      });
      await view.waitForTimeout(500);
      const seen = await stopWatch(view);
      expectNoBlankFrame(
        seen,
        from,
        guest.log,
        "while the word detail was slow",
      );
      const swapped = seen.filter((f) => f.t >= from && f.words > 0 && !f.same);
      expect(
        swapped.length,
        `the Script section was replaced in ${swapped.length} frame(s); first at +${swapped[0] ? (swapped[0].t - from).toFixed(0) : "-"}ms, busy=${swapped[0]?.busy} hostSame=${swapped[0]?.hostSame}\nGuest requests:\n${guest.log.join("\n")}`,
      ).toBe(0);
    },
  );
});

test("a failed word detail shows the cover with Retry, and Retry brings the words back", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "viewer", size: WIDE },
    async (guest) => {
      const { page: view } = guest;
      const { from } = await startWatch(view);
      guest.detail.status = 500;
      guest.detail.delayMs = 400;
      await hostEdit(page, guest.projectPath, "cut", 0);

      const retry = view.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible({ timeout: 15_000 });
      expect(await view.locator(WORD).count()).toBe(0);

      guest.detail.status = null;
      guest.detail.delayMs = 0;
      await retry.click();
      await expect(view.locator(WORD).first()).toBeVisible({ timeout: 15_000 });
      await expect(retry).toHaveCount(0);
      await view.waitForTimeout(500);
      const seen = await stopWatch(view);
      expectNoBlankFrame(seen, from, guest.log, "around a failed word detail");
      await expect(view.locator(SECTION)).not.toHaveAttribute(
        "aria-busy",
        "true",
      );
    },
  );
});
