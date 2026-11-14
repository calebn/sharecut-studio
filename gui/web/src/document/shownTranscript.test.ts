import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import type {
  CombinedUtterance,
  ProjectView,
  TranscriptWordView,
} from "../types/project";
import {
  type SettledTranscript,
  settledTranscriptOf,
  shownTranscriptOf,
  transcriptGrantOf,
} from "./shownTranscript";

const GRANT = "share:t|true|play";

const shownOf = (
  transcript: Parameters<typeof shownTranscriptOf>[0],
  settled: SettledTranscript | null,
  grant: string,
  complete = false,
) => shownTranscriptOf(transcript, settled, grant, complete);

function word(
  index: number,
  text: string,
  at: number | null,
  extra: Partial<TranscriptWordView> = {},
): TranscriptWordView {
  return {
    text,
    start: index,
    end: index + 1,
    word_index: index,
    timeline_start: at,
    timeline_end: at === null ? null : at + 0.5,
    ...extra,
  };
}

function row(
  start: number,
  texts: string[],
  at: number,
  extra: Partial<CombinedUtterance> = {},
  track = "a",
): CombinedUtterance {
  return {
    track_id: track,
    source_id: "s",
    speaker: "Ann",
    start,
    end: start + texts.length,
    text: texts.join(" "),
    timeline_start: at,
    timeline_end: at + texts.length,
    words: texts.map((t, i) => word(start + i, t, at + i)),
    ...extra,
  };
}

function header(u: CombinedUtterance): CombinedUtterance {
  const { words: _words, ...rest } = u;
  return rest;
}

function projectOf(
  utterances: CombinedUtterance[],
  complete: boolean,
): ProjectView {
  return minimalProject({
    transcript: { utterances } as ProjectView["transcript"],
    meta: {
      name: "t",
      workspace_dir: "/tmp",
      hydration: { transcript_words: complete },
    } as ProjectView["meta"],
  });
}

const settledOf = (utterances: CombinedUtterance[]): SettledTranscript => {
  const settled = settledTranscriptOf(projectOf(utterances, true), GRANT);
  if (!settled) throw new Error("expected a settled transcript");
  return settled;
};

const transcriptOf = (utterances: CombinedUtterance[]) =>
  projectOf(utterances, false).transcript;

const kinds = (shown: ReturnType<typeof shownTranscriptOf>) =>
  shown.rows.map((r) => r.kind);
const textsOf = (u: CombinedUtterance) => (u.words ?? []).map((w) => w.text);

describe("shownTranscriptOf", () => {
  const first = row(0, ["one", "two"], 0);
  const second = row(10, ["three", "four"], 4);
  const third = row(20, ["five", "six"], 8);

  it("draws every row live when the project has its words", () => {
    const shown = shownOf(transcriptOf([first, second]), null, GRANT, true);
    expect(kinds(shown)).toEqual(["live", "live"]);
    expect(shown.refreshing).toBe(false);
    expect(shown.drawn).toBe(true);
  });

  it("draws a row without words live once the project is complete", () => {
    const shown = shownOf(transcriptOf([header(first)]), null, GRANT, true);
    expect(kinds(shown)).toEqual(["live"]);
    expect(shown.refreshing).toBe(false);
  });

  it("has nothing to draw on first load: every row waits", () => {
    const shown = shownOf(
      transcriptOf([header(first), header(second)]),
      null,
      GRANT,
    );
    expect(kinds(shown)).toEqual(["waiting", "waiting"]);
    expect(shown.refreshing).toBe(true);
    expect(shown.drawn).toBe(false);
  });

  it("holds unchanged rows without times and waits on the row a cut re-keyed", () => {
    const settled = settledOf([first, second, third]);
    const cutRow = header({
      ...second,
      start: 10,
      end: 11,
      text: "three",
      timeline_start: 4,
    });
    const afterCut = transcriptOf([
      header({ ...first, timeline_start: 0 }),
      cutRow,
      header({ ...third, timeline_start: 5 }),
    ]);
    const shown = shownOf(afterCut, settled, GRANT);
    expect(kinds(shown)).toEqual(["held", "waiting", "held"]);
    expect(shown.refreshing).toBe(true);
    expect(shown.drawn).toBe(true);
    const held = shown.rows[2];
    if (held.kind !== "held") throw new Error("expected a held row");
    expect(textsOf(held.utterance)).toEqual(["five", "six"]);
    expect(
      held.utterance.words?.every(
        (w) => w.timeline_start === null && w.timeline_end === null,
      ),
    ).toBe(true);
    expect(held.lead).toBe(0);
  });

  it("keeps the lead of the first drawn word for order and label", () => {
    const lead = row(0, ["um", "hello"], 2, {
      words: [word(0, "um", 2, { suppressed: true }), word(1, "hello", 3)],
    });
    const shown = shownOf(
      transcriptOf([header({ ...lead, timeline_start: 0 })]),
      settledOf([lead]),
      GRANT,
    );
    const held = shown.rows[0];
    if (held.kind !== "held") throw new Error("expected a held row");
    expect(held.lead).toBe(1);
    expect(textsOf(held.utterance)).toEqual(["hello"]);
  });

  it("drops a row the cut removed entirely even though memory has it", () => {
    const settled = settledOf([first, second]);
    const shown = shownOf(
      transcriptOf([header(first), { ...header(second), mappable: false }]),
      settled,
      GRANT,
    );
    expect(kinds(shown)).toEqual(["held"]);
  });

  it("waits on a row whose text was corrected, and on a suppressed edge change", () => {
    const settled = settledOf([first, second]);
    const corrected = shownOf(
      transcriptOf([header({ ...first, text: "won two" }), header(second)]),
      settled,
      GRANT,
    );
    expect(kinds(corrected)).toEqual(["waiting", "held"]);
    const edge = shownOf(
      transcriptOf([
        header({ ...first, edge_suppressed_word_indices: [3] }),
        header({ ...second, suppressed_only: true }),
      ]),
      settled,
      GRANT,
    );
    expect(kinds(edge)).toEqual(["waiting", "waiting"]);
  });

  it("waits on a row whose ignored list is not the one its words were read under", () => {
    const struck = row(0, ["one", "two"], 0, {
      words: [word(0, "one", 0, { ignored: true }), word(1, "two", 1)],
      ignored_word_indices: [0],
    });
    const settled = settledOf([struck, second]);
    // ignore removed: the word is not drawn until the detail lands
    const removed = shownOf(
      transcriptOf([
        header({ ...struck, ignored_word_indices: undefined }),
        header(second),
      ]),
      settled,
      GRANT,
    );
    expect(kinds(removed)[0]).toBe("waiting");
    expect(removed.rows[0].utterance.words).toBeUndefined();
    // ignore added: the row waits, so no word is struck out by an old index
    const added = shownOf(
      transcriptOf([
        header(first),
        header({ ...second, ignored_word_indices: [11] }),
      ]),
      settledOf([first, second]),
      GRANT,
    );
    expect(kinds(added)).toEqual(["held", "waiting"]);
    expect(added.rows[1].utterance.words).toBeUndefined();
    // the same words with the list renumbered by a cut: waiting
    const renumbered = shownOf(
      transcriptOf([
        header({ ...struck, ignored_word_indices: [3] }),
        header(second),
      ]),
      settled,
      GRANT,
    );
    expect(kinds(renumbered)[0]).toBe("waiting");
    // an identical list is held
    const same = shownOf(
      transcriptOf([header(struck), header(second)]),
      settled,
      GRANT,
    );
    expect(kinds(same)[0]).toBe("held");
    expect(textsOf(same.rows[0].utterance)).toEqual(["two"]);
  });

  it("consumes duplicate takes in order, with a live row between", () => {
    const takeA = row(0, ["same", "line"], 0);
    const takeB = row(0, ["same", "line"], 5);
    const taken = (marks: string[]) => {
      let n = 0;
      return takeA.words?.map((w) => ({ ...w, text: marks[n++ % 2] })) ?? [];
    };
    const settledA = { ...takeA, words: taken(["A1", "A2"]) };
    const settledB = { ...takeB, words: taken(["B1", "B2"]) };
    const liveBetween = row(30, ["mid"], 3, {}, "b");
    const shown = shownOf(
      transcriptOf([
        header(takeA),
        liveBetween,
        header({ ...takeB, timeline_start: 9 }),
      ]),
      settledOf([settledA, settledB]),
      GRANT,
    );
    expect(kinds(shown)).toEqual(["held", "live", "held"]);
    expect(textsOf(shown.rows[0].utterance)).toEqual(["A1", "A2"]);
    expect(textsOf(shown.rows[2].utterance)).toEqual(["B1", "B2"]);
  });

  it("draws all-waiting rows as bars once this guest has seen words", () => {
    const struck = (r: CombinedUtterance) =>
      header({ ...r, ignored_word_indices: [r.start] });
    const shown = shownOf(
      transcriptOf([struck(first), struck(second)]),
      settledOf([first, second]),
      GRANT,
    );
    expect(kinds(shown)).toEqual(["waiting", "waiting"]);
    expect(shown.drawn).toBe(true);
  });

  it("draws every row as bars after one ripple cut at the start when every row has a struck word", () => {
    const before = [first, second].map((r) => ({
      ...r,
      ignored_word_indices: [r.start],
    }));
    const cut = [first, second].map((r) =>
      header({
        ...r,
        start: r.start - 1,
        words: undefined,
        ignored_word_indices: [r.start - 1],
      }),
    );
    const shown = shownOf(transcriptOf(cut), settledOf(before), GRANT);
    expect(kinds(shown)).toEqual(["waiting", "waiting"]);
    expect(shown.drawn).toBe(true);
  });

  it("holds a row that only moved and waits on one whose spans changed shape", () => {
    const spans = (...d: number[]) => {
      let at = 0;
      return d.map((len) => {
        const span = {
          start: at,
          end: at + len,
          source_start: 0,
          source_end: len,
        };
        at += len + 1;
        return span;
      });
    };
    const rigid = (r: CombinedUtterance, ...d: number[]) =>
      ({ ...r, timeline_spans: spans(...d) }) as CombinedUtterance;
    const settled = settledOf([rigid(first, 2), rigid(second, 2)]);
    const shifted = header({
      ...rigid(first, 2),
      timeline_spans: spans(2).map((s) => ({
        ...s,
        start: s.start + 7,
        end: s.end + 7,
      })),
    });
    const gapCut = header(rigid(second, 1, 1));
    const shown = shownOf(transcriptOf([shifted, gapCut]), settled, GRANT);
    expect(kinds(shown)).toEqual(["held", "waiting"]);
  });

  it("treats a memory kept under another grant as first load", () => {
    const shown = shownOf(
      transcriptOf([header(first)]),
      settledOf([first]),
      "share:t|true|play,comment",
    );
    expect(kinds(shown)).toEqual(["waiting"]);
    expect(shown.drawn).toBe(false);
  });

  it("never holds a word that was not drawn before", () => {
    const messy = row(0, ["a", "b", "c", "d"], 0, {
      words: [
        word(0, "a", 0),
        word(1, "b", 1, { suppressed: true }),
        word(2, "c", 2, { ignored: true }),
        word(3, "d", null),
        word(4, "e", 4, { mappable: false }),
        word(5, "f", 5),
      ],
    });
    const shown = shownOf(
      transcriptOf([header(messy)]),
      settledOf([messy]),
      GRANT,
    );
    expect(textsOf(shown.rows[0].utterance)).toEqual(["a", "f"]);
  });

  it("holds only words the memory drew, whatever the edit (random edits)", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let round = 0; round < 40; round += 1) {
      const memory = Array.from({ length: 5 }, (_, i) =>
        row(i * 10, ["w", "x", "y"], i * 4, {
          words: [0, 1, 2].map((n) =>
            word(i * 10 + n, `w${i}${n}`, i * 4 + n, {
              suppressed: next() < 0.2,
              ignored: next() < 0.2,
            }),
          ),
        }),
      );
      const drawn = new Set(
        memory.flatMap((u) =>
          (u.words ?? [])
            .filter((w) => !w.suppressed && !w.ignored)
            .map((w) => w.text),
        ),
      );
      const edited = memory
        .filter(() => next() > 0.2)
        .map((u) =>
          header({
            ...u,
            text: next() < 0.3 ? `${u.text} changed` : u.text,
            ignored_word_indices: next() < 0.3 ? [u.start] : undefined,
          }),
        );
      const shown = shownOf(transcriptOf(edited), settledOf(memory), GRANT);
      for (const r of shown.rows) {
        for (const w of r.utterance.words ?? []) {
          expect(drawn.has(w.text)).toBe(true);
          expect(w.timeline_start == null).toBe(true);
        }
      }
    }
  });

  it("answers the same object for the same inputs", () => {
    const transcript = transcriptOf([header(first)]);
    const settled = settledOf([first]);
    expect(shownOf(transcript, settled, GRANT)).toBe(
      shownOf(transcript, settled, GRANT),
    );
  });

  it("judges two edits in a row against the same memory", () => {
    const settled = settledOf([first, second, third]);
    const afterOne = transcriptOf([
      header(first),
      header({ ...second, text: "x" }),
      header(third),
    ]);
    const afterTwo = transcriptOf([
      header(first),
      header({ ...second, text: "x" }),
    ]);
    expect(kinds(shownOf(afterOne, settled, GRANT))).toEqual([
      "held",
      "waiting",
      "held",
    ]);
    expect(kinds(shownOf(afterTwo, settled, GRANT))).toEqual([
      "held",
      "waiting",
    ]);
  });
});

describe("settledTranscriptOf", () => {
  it("remembers only a project that has every word", () => {
    const rows = [row(0, ["a"], 0)];
    expect(settledTranscriptOf(projectOf(rows, true), GRANT)).toEqual({
      grant: GRANT,
      utterances: rows,
    });
    expect(settledTranscriptOf(projectOf(rows, false), GRANT)).toBeNull();
  });

  it("keeps the same memory object while the rows and grant are the same", () => {
    const rows = [row(0, ["a"], 0)];
    const first = settledTranscriptOf(projectOf(rows, true), GRANT);
    const again = settledTranscriptOf(projectOf(rows, true), GRANT, first);
    expect(again).toBe(first);
    expect(
      settledTranscriptOf(projectOf([row(0, ["a"], 0)], true), GRANT, first),
    ).not.toBe(first);
  });

  it("gives one shown transcript for two complete commits of the same rows", () => {
    const rows = [row(0, ["a"], 0)];
    const project = projectOf(rows, true);
    const one = { grant: GRANT, utterances: rows };
    const two = { grant: GRANT, utterances: rows };
    expect(shownOf(project.transcript, one, GRANT, true)).toBe(
      shownOf(project.transcript, two, GRANT, true),
    );
  });
});

describe("transcriptGrantOf", () => {
  it("is the same for the same grant in any capability order, and differs when it changes", () => {
    const base = {
      projectPath: "share:t",
      shareTranscriptWords: true,
    };
    expect(transcriptGrantOf({ ...base, shareCapabilities: ["b", "a"] })).toBe(
      transcriptGrantOf({ ...base, shareCapabilities: ["a", "b"] }),
    );
    expect(transcriptGrantOf({ ...base, shareCapabilities: ["a"] })).not.toBe(
      transcriptGrantOf({ ...base, shareCapabilities: ["a", "b"] }),
    );
    expect(
      transcriptGrantOf({
        ...base,
        shareTranscriptWords: false,
        shareCapabilities: ["a"],
      }),
    ).not.toBe(transcriptGrantOf({ ...base, shareCapabilities: ["a"] }));
  });
});
