import { expect, type Locator, type Page, test } from "@playwright/test";
import { USER_SCROLL_INTENT_MS } from "../src/hooks/useUserScrollIntent";
import { e2eProjectPath } from "./env";
import { seekTo } from "./playback";
import { openPanel, openProject, stageTab } from "./stageNav";
import { servePendingEditsCleared } from "./transcriptEdit";

type Word = Record<string, unknown>;

const LANES = ["reference", "guest"] as const;
const UTTERANCES_PER_LANE = 6;
const WORDS_PER_UTTERANCE = 3;
const UTTERANCE_PERIOD_SEC = 9;
const WORD_PERIOD_SEC = 3;
const WORD_LEN_SEC = 1.5;
/** Guest turn that is muted bleed: every word suppressed, overlapping reference speech. */
const BLEED_TURN = 3;
const PHRASE = "alpha bravo charlie delta echo foxtrot";

/**
 * Two overlapping dialogue lanes, one turn every nine seconds each, three words
 * per turn spaced three seconds apart so a playhead on whole seconds lands
 * inside a word, inside two words at once, and in the silence between words
 * of one turn. The guest lane starts one second after the reference lane.
 */
function twoLaneTranscript() {
  const utterances = LANES.flatMap((track, lane) =>
    Array.from({ length: UTTERANCES_PER_LANE }, (_, k) => {
      const start = k * UTTERANCE_PERIOD_SEC + lane;
      const bleed = track === "guest" && k === BLEED_TURN;
      const words: Word[] = Array.from(
        { length: WORDS_PER_UTTERANCE },
        (_, j) => {
          const t = start + j * WORD_PERIOD_SEC;
          return {
            text: `${track[0]}${k}.${j} ${PHRASE}`,
            word_index: k * WORDS_PER_UTTERANCE + j,
            start: t,
            end: t + WORD_LEN_SEC,
            timeline_start: t,
            timeline_end: t + WORD_LEN_SEC,
            mappable: true,
            confidence: 0.99,
            suppressed: bleed,
          };
        },
      );
      return {
        track_id: track,
        speaker: track,
        start,
        end: start + (WORDS_PER_UTTERANCE - 1) * WORD_PERIOD_SEC + WORD_LEN_SEC,
        text: words.map((w) => w.text).join(" "),
        timeline_start: start,
        timeline_end:
          start + (WORDS_PER_UTTERANCE - 1) * WORD_PERIOD_SEC + WORD_LEN_SEC,
        mappable: true,
        words,
      };
    }),
  );
  return utterances.sort((a, b) => a.start - b.start);
}

async function openFollowedTranscript(page: Page): Promise<Locator> {
  await servePendingEditsCleared(page, (project) => {
    project.transcript = { utterances: twoLaneTranscript() };
  });
  await openProject(page, e2eProjectPath);

  await openPanel(page, "transcript");
  const list = page.locator(".sys-script-body");
  await expect(list.locator(".sys-script-word")).toHaveCount(
    LANES.length * UTTERANCES_PER_LANE * WORDS_PER_UTTERANCE,
  );
  const follow = page.getByRole("button", { name: "Follow the playhead" });
  if ((await follow.getAttribute("aria-pressed")) !== "true") {
    await follow.click();
  }
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  expect(
    await list.evaluate((el) => el.clientHeight),
    "the transcript list has visible reading space",
  ).toBeGreaterThan(0);
  const overflow = await list.evaluate(
    (el) => el.scrollHeight - el.clientHeight,
  );
  expect(overflow, "the transcript list scrolls").toBeGreaterThan(200);
  return list;
}

/** scrollTop once the follow ease has finished. */
async function settledScrollTop(list: Locator): Promise<number> {
  let previous = Number.NaN;
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const now = await list.evaluate((el) => el.scrollTop);
    stable = now === previous ? stable + 1 : 0;
    previous = now;
    await list.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }
  if (stable < 3) {
    throw new Error(`scrollTop never settled, last read ${previous}`);
  }
  return previous;
}

/** 0 normally; a few px when both positions sit at the bottom of the list. */
async function bottomSlack(
  list: Locator,
  a: number,
  b: number,
): Promise<number> {
  const max = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
  return a >= max - BOTTOM_SLACK_PX && b >= max - BOTTOM_SLACK_PX
    ? BOTTOM_SLACK_PX
    : 0;
}

type Sample = {
  top: number;
  max: number;
  view: number;
  lead: { top: number; bottom: number } | null;
};

async function sample(list: Locator): Promise<Sample> {
  const top = await settledScrollTop(list);
  const max = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
  const { view, lead } = await list.evaluate((el) => {
    const word = el.querySelector<HTMLElement>(
      ".sys-script-word[data-playing]",
    );
    const view = el.clientHeight;
    if (!word) return { view, lead: null };
    const offset = el.scrollTop - el.getBoundingClientRect().top;
    const box = word.getBoundingClientRect();
    return {
      view,
      lead: { top: box.top + offset, bottom: box.bottom + offset },
    };
  });
  return { top, max, view, lead };
}

async function sweep(
  page: Page,
  list: Locator,
  key: "ArrowRight" | "ArrowLeft",
  seconds: number,
): Promise<Sample[]> {
  const samples = [await sample(list)];
  for (let i = 0; i < seconds; i++) {
    await page.keyboard.press(key);
    samples.push(await sample(list));
  }
  return samples;
}

/** Within a few px of the bottom, where an active turn's height moves the maximum. */
const BOTTOM_SLACK_PX = 8;

function trace(label: string, samples: Sample[]): string {
  return `${label} ${samples.map((f) => `${f.top}/${f.lead?.top}`).join(",")}`;
}

/**
 * Steps where scrollTop moved away from the leading playing word. Overlapping
 * lanes interleave in time but not in the list, so the lead word can sit above
 * the previous one and Follow then rightly scrolls up.
 */
function reversals(samples: Sample[]): number {
  return samples.slice(1).filter((now, i) => {
    const prev = samples[i];
    const pinned =
      now.top >= now.max - BOTTOM_SLACK_PX &&
      prev.top >= prev.max - BOTTOM_SLACK_PX;
    if (pinned || now.lead === null) return false;
    const delta = now.top - prev.top;
    const awayFromLead =
      (delta < -0.5 && now.lead.top >= prev.top + prev.view) ||
      (delta > 0.5 && now.lead.bottom <= prev.top);
    if (awayFromLead) return true;
    if (prev.lead === null) return false;
    return delta * (now.lead.top - prev.lead.top) < -0.5;
  }).length;
}

function needlessScrolls(samples: Sample[]): number {
  return samples.slice(1).filter((now, i) => {
    const prev = samples[i];
    const pinned =
      now.top >= now.max - BOTTOM_SLACK_PX &&
      prev.top >= prev.max - BOTTOM_SLACK_PX;
    if (pinned || Math.abs(now.top - prev.top) <= 0.5) return false;
    if (now.lead === null) return true;
    return (
      now.lead.top >= prev.top - 0.5 &&
      now.lead.bottom <= prev.top + prev.view + 0.5
    );
  }).length;
}

async function scrollAwayFromPlayhead(page: Page) {
  const list = await openFollowedTranscript(page);
  await seekTo(page, 30);
  const word = list.locator('[data-word-key="reference::10"]');
  await expect(word).toHaveAttribute("data-playing", "");
  // Fractional intersections can round just below 1.
  await expect(word).toBeInViewport({ ratio: 0.99 });
  const followingTop = await settledScrollTop(list);
  expect(followingTop).toBeGreaterThan(0);

  const back = page.getByRole("button", {
    name: "Back to playhead",
    exact: true,
  });
  const follow = page.getByRole("button", { name: "Follow the playhead" });
  await list.hover();
  await page.mouse.wheel(0, -followingTop - 100);
  await expect(back).toBeVisible();
  await expect(word).not.toBeInViewport();
  await expect(word).toHaveAttribute("data-playing", "");
  return { list, word, followingTop, back, follow };
}

async function expectFollowingPlayhead({
  word,
  back,
  follow,
}: Awaited<ReturnType<typeof scrollAwayFromPlayhead>>) {
  await expect(word).toBeInViewport({ ratio: 0.99 });
  await expect(back).toBeHidden();
  await expect(word).toHaveAttribute("data-playing", "");
  await expect(follow).toHaveAttribute("aria-pressed", "true");
}

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone portrait", width: 390, height: 844 },
  { name: "phone landscape", width: 844, height: 390 },
];

for (const viewport of viewports) {
  test.describe(`Transcript Follow with overlapping lanes, ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.afterEach(async ({ page }) => {
      await page.unrouteAll({ behavior: "wait" });
    });

    test("the playing word stays in view while Follow is on", async ({
      page,
    }) => {
      const list = await openFollowedTranscript(page);
      // Reference turn 3 runs 27..34.5 with words at 27, 30 and 33.
      for (const sec of [27, 30, 33]) {
        await seekTo(page, sec);
        const playing = list.locator(".sys-script-word[data-playing]").first();
        await expect(playing).toBeInViewport({ ratio: 1 });
      }
    });

    test("highlights overlapping playing words in transcript order", async ({
      page,
    }) => {
      const list = await openFollowedTranscript(page);
      const playing = list.locator(".sys-script-word[data-playing]");

      // The reference word spans 12–13.5 s; the guest word spans 13–14.5 s.
      for (const [second, keys] of [
        [12, ["reference::4"]],
        [13, ["reference::4", "guest::4"]],
        [14, ["guest::4"]],
      ] as const) {
        await seekTo(page, second);
        await expect
          .poll(
            () =>
              playing.evaluateAll((words) =>
                words.map((word) => word.getAttribute("data-word-key")),
              ),
            { message: `playing words at ${second}s` },
          )
          .toEqual(keys);
      }
    });

    test("Back to playhead restores the current word after a reading pause", async ({
      page,
    }) => {
      const script = await scrollAwayFromPlayhead(page);
      expect(await settledScrollTop(script.list)).toBeLessThan(
        script.followingTop,
      );

      const until = await page.evaluate(
        (duration) => performance.now() + duration,
        USER_SCROLL_INTENT_MS,
      );
      await page.waitForFunction((end) => performance.now() >= end, until);
      await script.back.click();
      await expectFollowingPlayhead(script);
    });

    for (const action of viewport.name === "desktop"
      ? (["Back to playhead", "Follow the playhead", "Edit"] as const)
      : (["Back to playhead"] as const)) {
      test(`a quick ${action} return resumes Follow until another scroll`, async ({
        page,
      }) => {
        const script = await scrollAwayFromPlayhead(page);
        if (action === "Edit") await stageTab(page, "edit").click();
        else
          await page.getByRole("button", { name: action, exact: true }).click();
        const returned = await settledScrollTop(script.list);
        await expectFollowingPlayhead(script);

        await script.list.hover();
        await page.mouse.wheel(0, -returned - 100);
        await expect(script.back).toBeVisible();
        await expect(script.follow).toHaveAttribute("aria-pressed", "false");
        await expect(script.word).not.toBeInViewport();
      });
    }

    test("a suppressed word at the playhead never moves the list", async ({
      page,
    }) => {
      const list = await openFollowedTranscript(page);
      // Guest turn 3 is muted bleed over 28..35.5. At 29 and 32 the reference
      // lane is silent between words, so the bleed is the only word in play.
      for (const sec of [29, 32]) {
        await seekTo(page, sec - 1);
        const parked = await settledScrollTop(list);
        await page.keyboard.press("ArrowRight");
        const now = await settledScrollTop(list);
        expect(
          Math.abs(now - parked),
          `scrollTop at ${sec}s`,
        ).toBeLessThanOrEqual(await bottomSlack(list, now, parked));
        await expect(
          list.locator(".sys-script-word[data-playing]"),
        ).toHaveCount(0);
      }
    });

    test("Follow scrolls only to reveal the playing word, never away from it", async ({
      page,
    }) => {
      const list = await openFollowedTranscript(page);
      await seekTo(page, 0);
      const forward = await sweep(page, list, "ArrowRight", 54);
      expect(forward.at(-1)?.top).toBeGreaterThan(forward[0].top);
      expect(reversals(forward), trace("forward", forward)).toBe(0);
      expect(needlessScrolls(forward), trace("forward", forward)).toBe(0);
      const backward = await sweep(page, list, "ArrowLeft", 54);
      expect(backward.at(-1)?.top).toBeLessThan(backward[0].top);
      expect(reversals(backward), trace("backward", backward)).toBe(0);
      expect(needlessScrolls(backward), trace("backward", backward)).toBe(0);
    });
  });
}
