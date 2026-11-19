import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSelectionRange } from "../edit/rangeSelection";
import { judgeWithScriptModel } from "../stage/edit/script/registerTranscriptSelectionFollower";
import { minimalProject } from "../test/fixtures";
import {
  named,
  PICK,
  snapshot,
  withWordsEdited,
  wordAt,
} from "../test/transcriptSelectionFixtures";
import type { ProjectView, Selection } from "../types/project";
import { useDawStore } from "./dawStore";
import { registerTranscriptSelectionFollower } from "./transcriptSelectionJudge";

const PATH = "/tmp/test/episode.sharecut";

function start(project: ProjectView) {
  const store = useDawStore.getState();
  store.hydrate(PATH, project);
  store.setSelection(PICK);
  return useDawStore.getState().selection;
}

function now() {
  return useDawStore.getState().selection;
}

beforeEach(() => {
  useDawStore.getState().hydrate("/tmp/other.sharecut", minimalProject());
  useDawStore.setState({ guestMode: null, rangeBusy: false });
});

describe("a words selection across another session's renumber", () => {
  it("follows its words to their new numbers and timeline place", () => {
    const b = snapshot({ removed: [1, 2] });
    start(snapshot());
    useDawStore.getState().setProject(b);
    expect(named(b, now())).toEqual(["w6", "w7", "w8"]);
    const [interval] = resolveSelectionRange(b, now()).targets[0]!.intervals;
    expect(interval!.start).toBeCloseTo(2.0, 5);
    expect(interval!.end).toBeCloseTo(3.3, 5);
  });

  it("follows its words on a same-path hydrate", () => {
    const b = snapshot({ removed: [1, 2] });
    start(snapshot());
    useDawStore.getState().hydrate(PATH, b);
    expect(named(b, now())).toEqual(["w6", "w7", "w8"]);
  });

  it("keeps the selection when a selected word is retimed in place", () => {
    const stored = start(snapshot());
    useDawStore.setState({ inspectorKey: "transcriptRange" });
    useDawStore.getState().setProject(snapshot({ retime: { 7: 0.1 } }));
    expect(now()).toBe(stored);
    expect(useDawStore.getState().inspectorKey).toBe("transcriptRange");
  });

  it("clears a run whose middle word is respelled while a word before it is removed", () => {
    start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ removed: [1], retext: { 7: "zzz" } }));
    expect(now()).toBeNull();
  });

  it("keeps the same selection object when the cut is after it", () => {
    const stored = start(snapshot());
    useDawStore.getState().setProject(snapshot({ removed: [9] }));
    expect(now()).toBe(stored);
  });

  it("follows the copy that has the stored numbers, never an equal-text neighbour", () => {
    const dup = wordAt(6, 0, 9.9, { start: 9.9, end: 10.2 });
    const b = snapshot({ removed: [1, 2], extra: [dup] });
    start(snapshot({ extra: [dup] }));
    useDawStore.getState().setProject(b);
    expect(now()).toEqual({ ...PICK, startWordIndex: 4, endWordIndex: 6 });
    expect(named(b, now())).toEqual(["w6", "w7", "w8"]);
  });

  it("leaves a review guest's selection to the guest script", () => {
    const stored = start(snapshot());
    useDawStore.setState({ guestMode: "comment" });
    useDawStore.getState().setProject(snapshot({ removed: [1, 2] }));
    expect(now()).toBe(stored);
  });
});

describe("a words selection when one of its own words changes", () => {
  it.each([
    ["first start", { 6: 0.1 }],
    ["last start", { 8: 0.1 }],
    ["first and last start", { 6: -0.1, 8: 0.1 }],
    ["every start", { 6: 0.1, 7: 0.1, 8: 0.1 }],
  ])("keeps the run when its %s is retimed in place", (_end, retime) => {
    const stored = start(snapshot());
    useDawStore.getState().setProject(snapshot({ retime }));
    expect(now()).toBe(stored);
  });

  it("keeps a single selected word retimed in place", () => {
    const single: Selection = {
      kind: "transcriptRange",
      trackId: "a",
      sourceId: null,
      startWordIndex: 7,
      endWordIndex: 7,
    };
    useDawStore.getState().hydrate(PATH, snapshot());
    useDawStore.getState().setSelection(single);
    const stored = now();
    useDawStore.getState().setProject(snapshot({ retime: { 7: -0.1 } }));
    expect(now()).toBe(stored);
  });

  it("keeps the run through the ordinary follow when only the end of its last word moved (no start moves, so not a retime)", () => {
    const stored = start(snapshot());
    const edited = withWordsEdited(snapshot(), (words) =>
      words.map((word) =>
        word.word_index === 8 ? { ...word, end: word.end + 0.2 } : word,
      ),
    );
    useDawStore.getState().setProject(edited);
    expect(now()).toBe(stored);
  });

  it("keeps the run when a retimed word comes with a text correction of another word in it", () => {
    const stored = start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ retime: { 7: 0.1 }, retext: { 8: "corrected" } }));
    expect(now()).toBe(stored);
  });

  it("keeps the run when one word is both retimed and respelled", () => {
    const stored = start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ retime: { 8: 0.1 }, retext: { 8: "corrected" } }));
    expect(now()).toBe(stored);
  });

  it("clears when a word before the run is respelled along with a retime in it", () => {
    start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ retime: { 7: 0.1 }, retext: { 2: "corrected" } }));
    expect(now()).toBeNull();
  });

  it("clears when a retime comes with a renumber before the run", () => {
    start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ retime: { 7: 0.1 }, removed: [1] }));
    expect(now()).toBeNull();
  });

  it("clears when a word outside the run is retimed with it", () => {
    start(snapshot());
    useDawStore.getState().setProject(snapshot({ retime: { 7: 0.1, 2: 0.1 } }));
    expect(now()).toBeNull();
  });

  it("clears when a retimed word lands nearer an equal-text word than itself", () => {
    const dup = wordAt(6, 0, 9.9, { start: 3.1, end: 3.4 });
    start(snapshot({ extra: [dup] }));
    useDawStore
      .getState()
      .setProject(snapshot({ extra: [dup], retime: { 6: 9 } }));
    expect(now()).toBeNull();
  });

  it.each([
    ["first", 6, 6],
    ["last", 8, 8],
  ])(
    "clears when the %s end was already cut and is retimed",
    (_end, cut, moved) => {
      useDawStore.getState().hydrate(PATH, snapshot({ cutAway: [cut] }));
      useDawStore.getState().setSelection(PICK);
      useDawStore
        .getState()
        .setProject(snapshot({ cutAway: [cut], retime: { [moved]: 0.1 } }));
      expect(now()).toBeNull();
    },
  );

  it("clears when a retimed word lands on the start of an equal-text word", () => {
    const dup = wordAt(7, 0, 9.9, { start: 3.6, end: 3.9 });
    start(snapshot({ extra: [dup] }));
    useDawStore
      .getState()
      .setProject(snapshot({ extra: [dup], retime: { 7: 0.1 } }));
    expect(now()).toBeNull();
  });

  it("clears when a retime moves a word to another recording", () => {
    start(snapshot());
    useDawStore.getState().setProject(
      snapshot({
        retime: { 7: 0.1 },
        otherSource: { words: [7], sourceId: "s2" },
      }),
    );
    expect(now()).toBeNull();
  });

  it("clears when a retimed word is also cut but still listed", () => {
    start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ retime: { 7: 0.1 }, cutAway: [7] }));
    expect(now()).toBeNull();
  });

  it.each([
    ["first", 6],
    ["middle", 7],
    ["last", 8],
  ])(
    "keeps the run when the %s selected word's text is corrected",
    (_end, word) => {
      const stored = start(snapshot());
      useDawStore.setState({ inspectorKey: "transcriptRange" });
      useDawStore
        .getState()
        .setProject(snapshot({ retext: { [word]: "corrected" } }));
      expect(now()).toBe(stored);
      expect(useDawStore.getState().inspectorKey).toBe("transcriptRange");
    },
  );

  it("keeps a single selected word whose text is corrected", () => {
    const single = { ...PICK, startWordIndex: 7, endWordIndex: 7 } as Selection;
    useDawStore.getState().hydrate(PATH, snapshot());
    useDawStore.getState().setSelection(single);
    const stored = now();
    useDawStore.getState().setProject(snapshot({ retext: { 7: "friend" } }));
    expect(now()).toBe(stored);
  });

  it("keeps the run when several of its words are respelled at once", () => {
    const stored = start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ retext: { 6: "x", 7: "y", 8: "z" } }));
    expect(now()).toBe(stored);
  });

  it("clears when a respelled run word is also cut but still listed", () => {
    start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ retext: { 7: "corrected" }, cutAway: [7] }));
    expect(now()).toBeNull();
  });

  it("clears when a respelled run word moves to another recording", () => {
    start(snapshot());
    useDawStore.getState().setProject(
      snapshot({
        retext: { 7: "corrected" },
        otherSource: { words: [7], sourceId: "s2" },
      }),
    );
    expect(now()).toBeNull();
  });

  it("clears when a phrase correction turns two selected words into one", () => {
    start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ removed: [7], retext: { 6: "merged" } }));
    expect(now()).toBeNull();
  });

  it("moves the run when a phrase correction before it turns two words into one", () => {
    start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ removed: [3], retext: { 2: "merged" } }));
    expect(now()).toEqual({ ...PICK, startWordIndex: 5, endWordIndex: 7 });
  });

  it("keeps the run when only a word before it is respelled", () => {
    start(snapshot());
    useDawStore.getState().setProject(snapshot({ retext: { 2: "corrected" } }));
    expect(now()).toEqual(PICK);
  });

  it("clears when a middle selected word moves to another recording", () => {
    start(snapshot());
    useDawStore
      .getState()
      .setProject(snapshot({ otherSource: { words: [7], sourceId: "s2" } }));
    expect(now()).toBeNull();
  });

  it("clears when a middle selected word is cut but still listed", () => {
    start(snapshot());
    useDawStore.getState().setProject(snapshot({ cutAway: [7] }));
    expect(now()).toBeNull();
  });

  it("clears when the first or last selected word is cut but still listed", () => {
    start(snapshot());
    useDawStore.getState().setProject(snapshot({ cutAway: [6] }));
    expect(now()).toBeNull();
    start(snapshot());
    useDawStore.getState().setProject(snapshot({ cutAway: [8] }));
    expect(now()).toBeNull();
  });

  it("keeps the same selection object when a cut word before the run only moves its place", () => {
    const stored = start(snapshot());
    useDawStore.getState().setProject(snapshot({ cutAway: [3] }));
    expect(now()).toBe(stored);
  });

  it("keeps the same selection object when the words only moved on the timeline", () => {
    const stored = start(snapshot());
    useDawStore.getState().setProject(snapshot({ shift: 2 }));
    expect(now()).toBe(stored);
  });

  it("keeps the same selection object when a replacement leaves everything as it was", () => {
    const stored = start(snapshot());
    useDawStore.getState().setProject(snapshot());
    expect(now()).toBe(stored);
  });

  it("keeps the selection when the end word straddles two utterances and nothing in the run changed", () => {
    const stored = start(snapshot({ straddle: 8 }));
    useDawStore
      .getState()
      .setProject(snapshot({ straddle: 8, retext: { 0: "edited" } }));
    expect(now()).toBe(stored);
  });

  it("keeps the selection when only the last copy of a straddling end word is respelled", () => {
    const stored = start(snapshot({ straddle: 8 }));
    useDawStore
      .getState()
      .setProject(snapshot({ straddle: 8, straddleText: "corrected" }));
    expect(now()).toBe(stored);
  });

  it("judges the run to the last copy of an end word that straddles two utterances", () => {
    start(snapshot({ straddle: 8 }));
    useDawStore.getState().setProject(snapshot({ straddle: 8, removed: [9] }));
    expect(now()).toBeNull();
  });
});

describe("while an own range action is in flight", () => {
  it("leaves the selection object alone", () => {
    const stored = start(snapshot());
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(snapshot({ removed: [1, 2] }));
    expect(now()).toBe(stored);
  });

  it("follows as soon as the action ends, with no further replacement", () => {
    const b = snapshot({ removed: [1, 2] });
    start(snapshot());
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(b);
    useDawStore.getState().setRangeBusy(false);
    expect(named(b, now())).toEqual(["w6", "w7", "w8"]);
  });

  it("clears as soon as the action ends when the renumber took a selected word", () => {
    start(snapshot());
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(snapshot({ removed: [7] }));
    useDawStore.getState().setRangeBusy(false);
    expect(now()).toBeNull();
  });

  it("is reset by a project switch, so the follow is not off for the session", () => {
    start(snapshot());
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().hydrate("/tmp/another.sharecut", snapshot());
    expect(useDawStore.getState().rangeBusy).toBe(false);
  });
});

describe("a selection made while the words are not there yet", () => {
  it("is cleared when the words arrive, not left on numbers nothing proves", () => {
    useDawStore.getState().hydrate(PATH, snapshot({ withWords: false }));
    useDawStore.getState().setSelection(PICK as Selection);
    useDawStore.getState().setProject(snapshot());
    expect(now()).toBeNull();
  });
});

describe("a replacement that cannot be judged yet", () => {
  afterEach(() => {
    vi.doUnmock("../edit/selectionFollow");
    vi.resetModules();
  });

  it("is judged from the project the selection was named in once it can", async () => {
    vi.resetModules();
    vi.doMock("../edit/selectionFollow", async (original) => {
      const actual = await original<typeof import("../edit/selectionFollow")>();
      let first = true;
      return {
        ...actual,
        followSelection: (
          ...args: Parameters<typeof actual.followSelection>
        ) => {
          if (!first) return actual.followSelection(...args);
          first = false;
          return { kind: "wait" as const };
        },
      };
    });
    await import("../stage/edit/script/registerTranscriptSelectionFollower");
    const { useDawStore: store } = await import("./dawStore");
    const b = snapshot({ removed: [1, 2] });
    store.getState().hydrate(PATH, snapshot());
    store.getState().setSelection(PICK);
    store.getState().setProject(b);
    store.getState().setProject({ ...b });
    expect(named(b, store.getState().selection)).toEqual(["w6", "w7", "w8"]);
  });
});

describe("a replacement that adds a line before the selected run", () => {
  it("keeps the selection", () => {
    const stored = start(snapshot());
    const base = snapshot();
    const lead = {
      ...base.transcript!.utterances[0]!,
      track_id: "b",
      words: [wordAt(0, 0, 0)],
    };
    useDawStore.getState().setProject({
      ...base,
      transcript: {
        ...base.transcript!,
        utterances: [lead, ...base.transcript!.utterances],
      },
    });
    expect(now()).toBe(stored);
  });
});

describe("the app bootstrap", () => {
  it("registers the follower the store judges a run with", async () => {
    vi.resetModules();
    const { judgeTranscriptSelection } = await import(
      "./transcriptSelectionJudge"
    );
    const from = snapshot();
    const next = snapshot({ removed: [1, 2] });
    const unregistered = judgeTranscriptSelection(from, PICK as never, next);
    expect(unregistered).toEqual({ kind: "keep" });
    await import("../App");
    const judged = judgeTranscriptSelection(from, PICK as never, next);
    expect(judged.kind).toBe("move");
  });
});

describe("a replacement that changes only the edit boundaries", () => {
  it("is judged, and clears a run that starts on a word the boundary now shows as cut", () => {
    const listed = snapshot({ cutAway: [7] });
    const { edit_boundaries, ...bare } = listed;
    useDawStore.getState().hydrate(PATH, bare);
    useDawStore
      .getState()
      .setSelection({ ...PICK, startWordIndex: 7 } as Selection);
    useDawStore.getState().setProject({ ...bare, edit_boundaries });
    expect(now()).toBeNull();
  });
});

describe("a selection named while the words were missing", () => {
  it("is not judged against the words-less project when an own action ends", () => {
    useDawStore.getState().hydrate(PATH, snapshot({ withWords: false }));
    useDawStore.getState().setSelection(PICK as Selection);
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(snapshot());
    useDawStore.getState().setRangeBusy(false);
    expect(now()).toEqual(PICK);
  });

  it("does not throw when the project is gone as an own action ends", () => {
    start(snapshot());
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(snapshot({ removed: [9] }));
    useDawStore.setState({ project: null });
    expect(() => useDawStore.getState().setRangeBusy(false)).not.toThrow();
  });
});

describe("a judged move that changes only one end number", () => {
  afterEach(() => registerTranscriptSelectionFollower(judgeWithScriptModel));

  it.each([
    ["end", { startWordIndex: 6, endWordIndex: 9 }],
    ["start", { startWordIndex: 5, endWordIndex: 8 }],
  ])("updates the %s number", (_end, moved) => {
    registerTranscriptSelectionFollower(() => ({ kind: "move", ...moved }));
    start(snapshot());
    useDawStore.getState().setProject(snapshot({ retime: { 0: 0.01 } }));
    expect(now()).toEqual({ ...PICK, ...moved });
  });
});

describe("judging a run from the numbers the store holds", () => {
  const prior = snapshot();
  const next = snapshot({ removed: [1, 2] });

  it.each([
    ["start", { ...PICK, startWordIndex: 99 }],
    ["end", { ...PICK, endWordIndex: 99 }],
  ])(
    "clears when the %s is not in the project it was named in",
    (_end, sel) => {
      expect(judgeWithScriptModel(prior, sel as never, next)).toEqual({
        kind: "clear",
      });
    },
  );

  it("clears when another session adds a word inside the run", () => {
    const copy = wordAt(8, 99, 50);
    const added = withWordsEdited(prior, (words) => [
      ...words.slice(0, 8),
      copy,
      ...words.slice(8),
    ]);
    expect(judgeWithScriptModel(prior, PICK as never, added)).toEqual({
      kind: "clear",
    });
  });

  it("clears when the first selected word was cut and is back", () => {
    const cut = snapshot({ cutAway: [6] });
    expect(judgeWithScriptModel(cut, PICK as never, snapshot())).toEqual({
      kind: "clear",
    });
  });

  it("clears when a moved end has no word_index", () => {
    const unnumbered = withWordsEdited(next, (words) =>
      words.map((w) =>
        w.text === "w8" ? { ...w, word_index: null as never } : w,
      ),
    );
    expect(judgeWithScriptModel(prior, PICK as never, unnumbered)).toEqual({
      kind: "clear",
    });
  });
});

describe("the inspector of a followed words selection", () => {
  it("stays open on the moved run", () => {
    start(snapshot());
    useDawStore.setState({ inspectorKey: "transcriptRange" });
    useDawStore.getState().setProject(snapshot({ removed: [1, 2] }));
    expect(now()).toEqual({ ...PICK, startWordIndex: 4, endWordIndex: 6 });
    expect(useDawStore.getState().inspectorKey).toBe("transcriptRange");
  });

  it("closes when the run is cleared", () => {
    start(snapshot());
    useDawStore.setState({ inspectorKey: "transcriptRange" });
    useDawStore.getState().setProject(snapshot({ removed: [7] }));
    expect(now()).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });
});

describe("a words selection with no project in the store", () => {
  it("is left as it is when a project arrives", () => {
    const stored = start(snapshot());
    useDawStore.setState({ project: null });
    expect(() =>
      useDawStore.getState().setProject(snapshot({ removed: [1, 2] })),
    ).not.toThrow();
    expect(now()).toBe(stored);
  });
});

describe("a selection that is not a run of words", () => {
  const OTHERS: [string, Selection][] = [
    ["envelope", { kind: "envelope", trackId: "a" }],
    ["envelope point", { kind: "envelopePoint", trackId: "a", pointId: "p1" }],
    ["clip", { kind: "clip", id: "c0", trackId: "a" }],
    ["track", { kind: "track", trackId: "a" }],
    ["seam", { kind: "seam", id: "eb:c0:c1", trackId: "a" }],
  ];
  const changed = () => snapshot({ removed: [1, 2] });

  function pick(selection: Selection) {
    useDawStore.getState().hydrate(PATH, snapshot());
    useDawStore.getState().setSelection(selection);
    const stored = now();
    expect(stored).toEqual(selection);
    return stored;
  }

  it.each(OTHERS)("%s is kept by a replaced project", (_kind, selection) => {
    const stored = pick(selection);
    useDawStore.getState().setProject(changed());
    expect(now()).toBe(stored);
  });

  it.each(OTHERS)("%s is kept by a same-path hydrate", (_kind, selection) => {
    const stored = pick(selection);
    useDawStore.getState().hydrate(PATH, changed());
    expect(now()).toBe(stored);
  });

  it.each(OTHERS)(
    "%s is kept when an own range action ends",
    (_kind, selection) => {
      const stored = pick(selection);
      useDawStore.getState().setRangeBusy(true);
      useDawStore.getState().setProject(changed());
      useDawStore.getState().setRangeBusy(false);
      expect(now()).toBe(stored);
    },
  );
});

describe("a words selection by the role the session holds", () => {
  const moved = () => snapshot({ removed: [1, 2] });

  it.each(["comment", "view", "review"])(
    "is left to the guest script for guest mode %s on a replaced project",
    (guestMode) => {
      const stored = start(snapshot());
      useDawStore.setState({ guestMode });
      useDawStore.getState().setProject(moved());
      expect(now()).toBe(stored);
    },
  );

  it.each(["comment", "view", "review"])(
    "is left to the guest script for guest mode %s when an own range action ends",
    (guestMode) => {
      const stored = start(snapshot());
      useDawStore.setState({ guestMode });
      useDawStore.getState().setRangeBusy(true);
      useDawStore.getState().setProject(moved());
      useDawStore.getState().setRangeBusy(false);
      expect(now()).toBe(stored);
    },
  );

  it("follows for an editor guest on a replaced project", () => {
    const b = moved();
    start(snapshot());
    useDawStore.setState({ guestMode: "edit" });
    useDawStore.getState().setProject(b);
    expect(named(b, now())).toEqual(["w6", "w7", "w8"]);
  });

  it("keeps the selection for an editor guest when a selected word is retimed in place", () => {
    const stored = start(snapshot());
    useDawStore.setState({ guestMode: "edit" });
    useDawStore.getState().setProject(snapshot({ retime: { 7: 0.1 } }));
    expect(now()).toBe(stored);
  });

  it("keeps the selection for an editor guest when a selected word's text is corrected", () => {
    const stored = start(snapshot());
    useDawStore.setState({ guestMode: "edit" });
    useDawStore.getState().setProject(snapshot({ retext: { 7: "corrected" } }));
    expect(now()).toBe(stored);
  });

  it("is left to the guest script for review mode when a selected word's text is corrected", () => {
    const stored = start(snapshot());
    useDawStore.setState({ guestMode: "review" });
    useDawStore.getState().setProject(snapshot({ retext: { 7: "corrected" } }));
    expect(now()).toBe(stored);
  });

  it("follows for an editor guest when an own range action ends", () => {
    const b = moved();
    start(snapshot());
    useDawStore.setState({ guestMode: "edit" });
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(b);
    useDawStore.getState().setRangeBusy(false);
    expect(named(b, now())).toEqual(["w6", "w7", "w8"]);
  });
});
