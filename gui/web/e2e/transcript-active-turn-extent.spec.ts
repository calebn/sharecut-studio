import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

/**
 * #1796: the turn that becomes active used to gain an accent bar and a gutter
 * that its inactive neighbours lacked, so its text wrapped differently and the
 * list's scroll extent moved by a line each time the active turn changed. The
 * extent must stay put while the playhead walks the whole transcript.
 */
const LANES = ["reference", "guest"] as const;
const UTTERANCES_PER_LANE = 6;
const WORDS_PER_UTTERANCE = 3;
const UTTERANCE_PERIOD_SEC = 9;
const WORD_PERIOD_SEC = 3;
const WORD_LEN_SEC = 1.5;
const PHRASE = "alpha bravo charlie delta echo foxtrot";
const WALK_SECONDS = 56;

function twoLaneTranscript() {
  const utterances = LANES.flatMap((track, lane) =>
    Array.from({ length: UTTERANCES_PER_LANE }, (_, k) => {
      const start = k * UTTERANCE_PERIOD_SEC + lane;
      const words = Array.from({ length: WORDS_PER_UTTERANCE }, (_, j) => {
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
          suppressed: false,
        };
      });
      const end =
        start + (WORDS_PER_UTTERANCE - 1) * WORD_PERIOD_SEC + WORD_LEN_SEC;
      return {
        track_id: track,
        speaker: track,
        start,
        end,
        text: words.map((w) => w.text).join(" "),
        timeline_start: start,
        timeline_end: end,
        mappable: true,
        words,
      };
    }),
  );
  return utterances.sort((a, b) => a.start - b.start);
}

const VIEWPORTS = [
  { name: "320x568 phone portrait", width: 320, height: 568, compact: true },
  { name: "360x640 phone portrait", width: 360, height: 640, compact: true },
  { name: "390x844 phone portrait", width: 390, height: 844, compact: true },
  { name: "667x375 phone landscape", width: 667, height: 375, compact: true },
  { name: "1280x800 desktop", width: 1280, height: 800, compact: false },
] as const;

for (const viewport of VIEWPORTS) {
  test(`the transcript scroll extent holds while the active turn changes at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
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
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await page
      .getByRole(viewport.compact ? "button" : "tab", {
        name: viewport.compact ? "Text" : "Transcript",
        exact: true,
      })
      .click();
    const list = page.locator(".transcript-list");
    await expect(list.locator("[data-transcript-word]")).toHaveCount(
      LANES.length * UTTERANCES_PER_LANE * WORDS_PER_UTTERANCE,
    );
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.keyboard.press("Home");
    const extents = new Set<number>();
    const activeTurns = new Set<number>();
    for (let sec = 0; sec <= WALK_SECONDS; sec++) {
      await list.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const state = await list.evaluate((el) => ({
        extent: el.scrollHeight,
        active: Array.from(el.querySelectorAll(".utterance-turn")).findIndex(
          (turn) => turn.classList.contains("active"),
        ),
      }));
      extents.add(state.extent);
      activeTurns.add(state.active);
      await page.keyboard.press("ArrowRight");
    }
    expect(
      activeTurns.size,
      "the walk crosses several active turns",
    ).toBeGreaterThan(3);
    expect(
      [...extents],
      "one scroll extent for every active turn",
    ).toHaveLength(1);
  });
}
