import { expect, type Page, test } from "@playwright/test";
import { deferred } from "../src/test/deferred";
import { postDocumentCommand } from "./documentCommand";
import {
  expectNoBlankFrame,
  frames,
  hostEdit,
  painted,
  REASON,
  ROLES,
  SECTION,
  SIZES,
  settled,
  startWatch,
  stopWatch,
  type Watched,
  WIDE,
  WORD,
  withGuest,
} from "./guestTranscript";
import { playButton } from "./playback";
import { parseTimecodeSec } from "./timecode";

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

test("a guest sees why playback paused after a host cut", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "commenter", size: WIDE },
    async ({ page: guest, projectPath }) => {
      const notice = "Playback paused because the episode changed.";
      const feedback = guest.getByRole("region", { name: "Status messages" });
      const play = playButton(guest);
      const initial = await seconds(guest);
      await play.click();
      await expect.poll(() => seconds(guest)).toBeGreaterThan(initial);

      await postDocumentCommand(
        page,
        "e2e-audio-note",
        "AddComment",
        { body: "Guest audio note", author: "Host", timeline_start: 15 },
        projectPath,
      );
      await expect(
        guest.getByRole("button", { name: /^Host 0:15 Guest audio note$/ }),
      ).toBeVisible();
      await expect(
        guest.getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible();
      await expect(feedback.getByText(notice)).toHaveCount(0);

      await hostEdit(page, projectPath, "cut", 0);
      await expect(play).toBeVisible();
      await expect(feedback.getByText(notice)).toBeVisible();
      await expect(
        guest.getByRole("status").filter({ hasText: notice }),
      ).toHaveCount(1);
      const paused = await seconds(guest);
      await play.click();
      await expect.poll(() => seconds(guest)).toBeGreaterThan(paused);
    },
  );
});

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
      // Select before the edit: a gesture on a held word is dropped, since a
      // cut renumbers word_index.
      await last.click();
      await expect(
        view.getByRole("group", { name: "Selection actions" }),
      ).toBeVisible();
      const selectedWords = () =>
        view
          .locator(`${WORD}[data-selected]`)
          .evaluateAll((els) => els.map((el) => el.textContent?.trim()));
      const picked = await selectedWords();
      expect(picked.length).toBeGreaterThan(0);
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
      await painted(view);
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
      await painted(view);
      expect(
        await selectedWords(),
        "the same words are still selected after the swap",
      ).toEqual(picked);
      await view.locator(`${WORD}[data-selected]`).first().click();
      await painted(view);
      const heard = await seconds(view);
      await bar.getByRole("button", { name: "Comment" }).click();
      const chip = await view
        .locator(".rv-compose .sys-composer-chip .sys-mono")
        .innerText();
      // A range chip reads "start to end": the start is the words' first time.
      const pinned = parseTimecodeSec(chip.split(" to ")[0] ?? "");
      expect(
        Math.abs(pinned - heard),
        "Comment anchors to the words' new time",
      ).toBeLessThan(1.5);
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
        `the Script section was replaced in ${swapped.length} frame(s)\nGuest requests:\n${guest.log.join("\n")}`,
      ).toBe(0);
    },
  );
});

for (const size of SIZES) {
  const target = size.phone ? WIDE : SIZES[0];
  test(`a guest's Script selection follows its words after resizing from ${size.width} to ${target.width}px`, async ({
    browser,
    page,
  }) => {
    await withGuest(
      browser,
      page,
      { role: "commenter", size },
      async (guest) => {
        const { page: view } = guest;
        const section = view.locator(SECTION);
        const words = view.locator(`${WORD}[data-word-key^="guest:"]`);
        const selected = view.locator(`${WORD}[data-selected]`);
        const bar = view.getByRole("group", { name: "Selection actions" });
        if (size.phone) await words.last().tap();
        else await words.last().click();
        await expect(selected).toHaveCount(1);
        const picked = (await selected.innerText()).trim();
        const originalTime = await seconds(view);
        const originalKey = await selected.getAttribute("data-word-key");
        if (!originalKey) throw new Error("The selected word has no key");
        const originalSection = await section.elementHandle();
        if (!originalSection) throw new Error("Script did not mount");

        await view.setViewportSize(target);
        await settled(view);
        await expect
          .poll(() => originalSection.evaluate((el) => el.isConnected))
          .toBe(false);
        await originalSection.dispose();
        await expect(selected).toHaveText(picked);

        const detail = deferred<void>();
        guest.detail.waitFor = detail.promise;
        try {
          await hostEdit(page, guest.projectPath, "cut", 0);
          await expect(section).toHaveAttribute("aria-busy", "true");
        } finally {
          detail.resolve();
        }
        await settled(view);
        const survivor = words.last();
        await expect(survivor).toHaveText(picked);
        await expect(survivor).not.toHaveAttribute(
          "data-word-key",
          originalKey,
        );
        await expect(selected).toHaveText(picked);
        const survivorKey = await survivor.getAttribute("data-word-key");
        if (!survivorKey) throw new Error("The surviving word has no key");
        await expect(selected).toHaveAttribute("data-word-key", survivorKey);

        // The first ripple removed five seconds before the picked word.
        await hostEdit(
          page,
          guest.projectPath,
          "cut",
          0,
          Math.max(0, originalTime - 6),
        );
        await expect(
          view.locator(`${WORD}[data-word-key="${survivorKey}"]`),
        ).toHaveCount(0);
        await settled(view);
        await expect(words.last()).not.toHaveText(picked);
        await expect(selected).toHaveCount(0);
        await expect(bar).toHaveCount(0);
      },
    );
  });
}

test("the guest Script keeps a cross-speaker selection announcement during refresh", async ({
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
      const status = section.getByRole("status");
      await view.locator(`${WORD}[data-word-key^="reference:"]`).last().click();
      await view
        .locator(`${WORD}[data-word-key^="guest:"]`)
        .last()
        .click({ modifiers: ["Shift"] });
      const selected = view.locator(`${WORD}[data-selected]`);
      const picked = await selected.allTextContents();
      const tracks = await selected.evaluateAll((words) => [
        ...new Set(
          words.map(
            (word) => word.getAttribute("data-word-key")?.split(":")[0],
          ),
        ),
      ]);
      expect(tracks).toEqual(["reference", "guest"]);
      await expect(status).toHaveText(/^\d+ words selected/);
      const announcement = await status.textContent();
      const spoken = await status.evaluateHandle((el) => {
        const changes: (string | null)[] = [];
        const watcher = new MutationObserver(() =>
          changes.push(el.textContent),
        );
        watcher.observe(el, {
          subtree: true,
          characterData: true,
          childList: true,
        });
        return { changes, watcher };
      });

      const held = deferred<void>();
      guest.detail.waitFor = held.promise;
      try {
        await hostEdit(page, guest.projectPath, "cut", 0);
        await expect(section).toHaveAttribute("aria-busy", "true");
        await painted(view);
        expect(await status.textContent()).toBe(announcement);
      } finally {
        held.resolve();
      }

      await expect(section).not.toHaveAttribute("aria-busy", "true");
      await expect.poll(() => selected.allTextContents()).toEqual(picked);
      await painted(view);
      expect(
        await spoken.evaluate(({ changes, watcher }) => {
          watcher.disconnect();
          return changes;
        }),
      ).toEqual([]);
      await spoken.dispose();
      await selected.last().focus();
      await view.keyboard.press("Escape");
      await expect(selected).toHaveCount(0);
      await expect(status).toHaveText("Selection cleared");
    },
  );
});

for (const size of SIZES) {
  test(`a failed word detail can be retried with the keyboard at ${size.width}px`, async ({
    browser,
    page,
  }) => {
    await withGuest(browser, page, { role: "viewer", size }, async (guest) => {
      const { page: view } = guest;
      const { from } = await startWatch(view);
      guest.detail.status = 500;
      guest.detail.delayMs = 400;
      await hostEdit(page, guest.projectPath, "cut", 0);

      const retry = view.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible({ timeout: 15_000 });
      expect(await view.locator(WORD).count()).toBe(0);
      await expect(retry).toBeFocused();

      guest.detail.status = null;
      guest.detail.delayMs = 0;
      await view.keyboard.press("Enter");
      await expect(view.locator(WORD).first()).toBeVisible({ timeout: 15_000 });
      await expect(retry).toHaveCount(0);
      await painted(view);
      const seen = await stopWatch(view);
      expectNoBlankFrame(seen, from, guest.log, "around a failed word detail");
      await expect(view.locator(SECTION)).not.toHaveAttribute(
        "aria-busy",
        "true",
      );
    });
  });
}

test("a failed word detail leaves the focused comment field alone", async ({
  browser,
  page,
}) => {
  await withGuest(
    browser,
    page,
    { role: "commenter", size: WIDE },
    async ({ page: view, projectPath, detail }) => {
      const comment = view.getByRole("textbox", {
        name: "Comment",
        exact: true,
      });
      await comment.fill("Keep this draft");
      await expect(comment).toBeFocused();

      detail.status = 500;
      detail.delayMs = 400;
      await hostEdit(page, projectPath, "cut", 0);

      await expect(
        view.getByRole("heading", { name: "The transcript didn't load" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(comment).toBeFocused();
      await expect(comment).toHaveValue("Keep this draft");
    },
  );
});
