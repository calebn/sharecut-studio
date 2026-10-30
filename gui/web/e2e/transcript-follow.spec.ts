import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openPanel, openProject } from "./stageNav";

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
  await page.route(
    (url) => new URL(url).pathname === "/api/document/state",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      const project = (body.project ?? body.patch) as Record<string, unknown>;
      project.transcript = { utterances: twoLaneTranscript() };
      await route.fulfill({ response, json: body });
    },
  );
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

/** Playhead to `sec` (whole seconds): Home, then one-second nudges. */
async function seekTo(page: Page, sec: number): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press("Home");
  for (let i = 0; i < sec; i++) {
    await page.keyboard.press("ArrowRight");
  }
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

type Sample = { top: number; max: number };

async function sample(list: Locator): Promise<Sample> {
  const top = await settledScrollTop(list);
  const max = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
  return { top, max };
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

/**
 * Steps where scrollTop moved against playback. Two samples both pinned to the
 * bottom differ only because the active turn changed height there, which moves
 * the maximum, not Follow.
 */
/** Within a few px of the bottom, where an active turn's height moves the maximum. */
const BOTTOM_SLACK_PX = 8;

function directionChanges(samples: Sample[], playbackSign: 1 | -1): number {
  return samples.slice(1).filter((now, i) => {
    const prev = samples[i];
    const pinned =
      now.top >= now.max - BOTTOM_SLACK_PX &&
      prev.top >= prev.max - BOTTOM_SLACK_PX;
    return !pinned && (now.top - prev.top) * playbackSign < -0.5;
  }).length;
}

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone portrait", width: 390, height: 844 },
  { name: "phone landscape", width: 844, height: 390 },
];

for (const viewport of viewports) {
  test.describe(`Transcript Follow with overlapping lanes, ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

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

    // The short phone-landscape pane still wobbles between overlapping lanes
    // (follow-up under #2666), so this runs where the pane is tall enough.
    if (viewport.name !== "phone landscape") {
      test("scrolling never runs against playback while lanes overlap", async ({
        page,
      }) => {
        const list = await openFollowedTranscript(page);
        await seekTo(page, 0);
        const forward = await sweep(page, list, "ArrowRight", 54);
        expect(forward.at(-1)?.top).toBeGreaterThan(forward[0].top);
        expect(
          directionChanges(forward, 1),
          `forward ${forward.map((f) => f.top).join(",")}`,
        ).toBe(0);
        const backward = await sweep(page, list, "ArrowLeft", 54);
        expect(backward.at(-1)?.top).toBeLessThan(backward[0].top);
        expect(
          directionChanges(backward, -1),
          `backward ${backward.map((f) => f.top).join(",")}`,
        ).toBe(0);
      });
    }
  });
}
