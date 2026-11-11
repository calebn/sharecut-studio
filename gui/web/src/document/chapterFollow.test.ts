import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ProjectView } from "../types/project";
import { applyDocumentSnapshot } from "./applyDocumentUpdate";
import { resetDocumentSeqForTests } from "./cursor";
import { revertOptimisticIfUnchanged } from "./optimisticRevert";

vi.mock("../api/project", () => ({ loadDocumentState: vi.fn() }));

const PATH = "/tmp/p.json";

const withChapters = (...rows: [string, number][]): ProjectView =>
  minimalProject({
    chapters: rows.map(([title, time]) => ({ title, time })),
  } as never);

function open(project: ProjectView, title: string, time: number) {
  useDawStore.getState().hydrate(PATH, project);
  useDawStore.setState({
    selection: { kind: "chapter", id: title, time },
    inspectorKey: `chapter:${title}`,
  });
}

let seq = 0;
function replaceWith(project: ProjectView) {
  seq += 1;
  applyDocumentSnapshot({
    server_seq: seq,
    state_token: `t${seq}`,
    project,
    file: { mtime_ns: seq, size: seq },
  });
}

describe("a chapter selection across the real project entry points", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    seq = 0;
  });

  it("follows an undo that renamed the chapter and back through redo", () => {
    const original = withChapters(["Opening", 10], ["Outro", 90]);
    open(original, "Opening", 10);
    replaceWith(original);
    replaceWith(withChapters(["Cold open", 10], ["Outro", 90]));
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Cold open",
      time: 10,
    });
    expect(useDawStore.getState().inspectorKey).toBe("chapter:Cold open");
    replaceWith(withChapters(["Opening", 10], ["Outro", 90]));
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Opening",
      time: 10,
    });
    expect(useDawStore.getState().inspectorKey).toBe("chapter:Opening");
  });

  it("follows a move and closes when the chapter is removed", () => {
    const original = withChapters(["Opening", 10], ["Outro", 90]);
    open(original, "Opening", 10);
    replaceWith(original);
    replaceWith(withChapters(["Opening", 25], ["Outro", 90]));
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Opening",
      time: 25,
    });
    replaceWith(withChapters(["Outro", 90]));
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });

  it("keeps a closed Inspector closed while following", () => {
    const original = withChapters(["Opening", 10]);
    open(original, "Opening", 10);
    useDawStore.setState({ inspectorKey: null });
    replaceWith(original);
    replaceWith(withChapters(["Cold open", 10]));
    expect(useDawStore.getState().selection).toMatchObject({
      id: "Cold open",
    });
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });

  it("follows the chapter back when an optimistic rename is reverted", () => {
    const previous = withChapters(["Opening", 10], ["Outro", 90]);
    const optimistic = withChapters(["Cold open", 10], ["Outro", 90]);
    open(previous, "Opening", 10);
    useDawStore.getState().setProject(optimistic);
    expect(useDawStore.getState().selection).toMatchObject({
      id: "Cold open",
    });
    revertOptimisticIfUnchanged(previous, 0, PATH, optimistic);
    expect(useDawStore.getState().project).toBe(previous);
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Opening",
      time: 10,
    });
    expect(useDawStore.getState().inspectorKey).toBe("chapter:Opening");
  });

  it("stays closed when an optimistic delete is reverted", () => {
    const previous = withChapters(["Opening", 10], ["Outro", 90]);
    const optimistic = withChapters(["Outro", 90]);
    open(previous, "Opening", 10);
    useDawStore.getState().setProject(optimistic);
    expect(useDawStore.getState().selection).toBeNull();
    revertOptimisticIfUnchanged(previous, 0, PATH, optimistic);
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });
});

describe("a same-path hydrate", () => {
  it("follows a renamed chapter and keeps the Inspector on it", () => {
    open(withChapters(["Opening", 10], ["Outro", 90]), "Opening", 10);
    useDawStore
      .getState()
      .hydrate(PATH, withChapters(["Cold open", 10], ["Outro", 90]));
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Cold open",
      time: 10,
    });
    expect(useDawStore.getState().inspectorKey).toBe("chapter:Cold open");
  });

  it("closes the selection when the chapter is gone", () => {
    open(withChapters(["Opening", 10], ["Outro", 90]), "Opening", 10);
    useDawStore.getState().hydrate(PATH, withChapters(["Outro", 90]));
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });

  it("drops the selection on a project switch", () => {
    open(withChapters(["Opening", 10]), "Opening", 10);
    useDawStore
      .getState()
      .hydrate("/tmp/other.json", withChapters(["Opening", 10]));
    expect(useDawStore.getState().selection).toBeNull();
  });
});

describe("duplicate chapters sharing title and time", () => {
  it("keeps the selection while any duplicate remains, and closes once none does", () => {
    const twin = withChapters(["Opening", 10], ["Opening", 10]);
    open(twin, "Opening", 10);
    useDawStore.getState().setProject(withChapters(["Opening", 10]));
    expect(useDawStore.getState().selection).toMatchObject({ id: "Opening" });
    useDawStore.getState().setProject(withChapters());
    expect(useDawStore.getState().selection).toBeNull();
  });
});

describe("an unrelated delete plus add", () => {
  it("closes the selection and the Inspector instead of following", () => {
    open(withChapters(["Opening", 10], ["Outro", 90]), "Opening", 10);
    useDawStore
      .getState()
      .setProject(withChapters(["Wrap", 95], ["Outro", 90]));
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });
});
