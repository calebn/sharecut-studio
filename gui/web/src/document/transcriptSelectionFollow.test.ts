import { beforeEach, describe, expect, it, vi } from "vitest";
import "../stage/edit/script/registerTranscriptSelectionFollower";
import { useDawStore } from "../state/dawStore";
import { named, PICK, snapshot } from "../test/transcriptSelectionFixtures";
import type { ProjectView } from "../types/project";
import { applyDocumentSnapshot } from "./applyDocumentUpdate";
import { resetDocumentSeqForTests } from "./cursor";
import { revertOptimisticIfUnchanged } from "./optimisticRevert";

vi.mock("../api/project", () => ({ loadDocumentState: vi.fn() }));

const PATH = "/tmp/p.json";

let seq = 0;
function replaceWith(next: ProjectView) {
  seq += 1;
  applyDocumentSnapshot({
    server_seq: seq,
    state_token: `t${seq}`,
    project: next,
    file: { mtime_ns: seq, size: seq },
  });
}

const project = (removed: readonly number[] = [], withWords = true) =>
  snapshot({ removed, withWords });

function names() {
  const { project: shown, selection } = useDawStore.getState();
  return shown ? named(shown, selection) : [];
}

function open(first: ProjectView) {
  useDawStore.setState({ guestMode: null, rangeBusy: false });
  useDawStore.getState().hydrate(PATH, first);
  useDawStore.getState().setSelection(PICK);
  replaceWith(first);
}

describe("a words selection across the real project entry points", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    seq = 0;
  });

  it("follows a full snapshot of another session's earlier cut, its undo and its redo", () => {
    open(project());
    replaceWith(project([1, 2]));
    expect(names()).toEqual(["w6", "w7", "w8"]);
    replaceWith(project());
    expect(names()).toEqual(["w6", "w7", "w8"]);
    replaceWith(project([1, 2]));
    expect(names()).toEqual(["w6", "w7", "w8"]);
  });

  it("follows a projection patch", () => {
    open(project());
    applyDocumentSnapshot({
      patch: { transcript: project([1, 2]).transcript },
    });
    expect(names()).toEqual(["w6", "w7", "w8"]);
  });

  it("waits through a replacement that has no words and follows when they arrive", () => {
    open(project());
    const stored = useDawStore.getState().selection;
    applyDocumentSnapshot({ project: project([1, 2], false) });
    expect(useDawStore.getState().selection).toBe(stored);
    applyDocumentSnapshot({ project: project([1, 2]) });
    expect(names()).toEqual(["w6", "w7", "w8"]);
  });

  it("clears when the words that arrive no longer hold the selected words", () => {
    open(project());
    applyDocumentSnapshot({ project: project([7], false) });
    applyDocumentSnapshot({ project: project([7]) });
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("follows the project an optimistic edit is reverted to", () => {
    const first = project();
    open(first);
    const optimistic = project([1, 2]);
    useDawStore.getState().setProject(optimistic);
    expect(names()).toEqual(["w6", "w7", "w8"]);
    revertOptimisticIfUnchanged(first, 0, PATH, optimistic);
    expect(names()).toEqual(["w6", "w7", "w8"]);
  });

  it("leaves an Editor guest's selection to follow like a host's", () => {
    open(project());
    useDawStore.setState({ guestMode: "edit" });
    replaceWith(project([1, 2]));
    expect(names()).toEqual(["w6", "w7", "w8"]);
  });
});
