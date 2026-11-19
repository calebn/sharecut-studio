import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSelectionRange } from "../edit/rangeSelection";
import { minimalProject } from "../test/fixtures";
import {
  named,
  PICK,
  snapshot,
  wordAt,
} from "../test/transcriptSelectionFixtures";
import type { ProjectView, Selection } from "../types/project";
import "../stage/edit/script/registerTranscriptSelectionFollower";
import { useDawStore } from "./dawStore";

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

  it("clears when a selected word is retimed", () => {
    start(snapshot());
    useDawStore.getState().setProject(snapshot({ retime: { 7: 0.1 } }));
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

describe("while an own range action is in flight", () => {
  it("leaves the selection object alone", () => {
    const stored = start(snapshot());
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(snapshot({ removed: [1, 2] }));
    expect(now()).toBe(stored);
  });

  it("follows from the project it was named in once the action ends", () => {
    const b = snapshot({ removed: [1, 2] });
    start(snapshot());
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(b);
    useDawStore.getState().setRangeBusy(false);
    useDawStore.getState().setProject({ ...b });
    expect(named(b, now())).toEqual(["w6", "w7", "w8"]);
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

  it("clears after the action when the renumber took a selected word", () => {
    const b = snapshot({ removed: [7] });
    start(snapshot());
    useDawStore.getState().setRangeBusy(true);
    useDawStore.getState().setProject(b);
    useDawStore.getState().setRangeBusy(false);
    useDawStore.getState().setProject({ ...b });
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
