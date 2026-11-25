import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import * as reveal from "../utils/timelineReveal";
import { COMMANDS } from "./catalog";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const SELECTION = { kind: "clip", id: "c1", trackId: "mira-voice" } as const;

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  useDawStore.setState({
    stage: "edit",
    selection: SELECTION,
    playheadSec: 7,
    timelineFollowPlayhead: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  reveal.selectionAnchor.clear();
});

describe("view.revealSelection", () => {
  it("is a view-only command with no key, labelled for a selection or an edit", () => {
    const def = COMMANDS["view.revealSelection"];
    expect(def).toMatchObject({
      label: "Show selection",
      variants: ["Show edit"],
      when: "hasInspectorSelection",
      category: "view",
    });
    expect(def?.notes).toContain("no key");
  });

  it("brings the selection's anchor into view and moves nothing else", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    reveal.selectionAnchor.set({ current: node });
    const spy = vi.spyOn(reveal, "revealAnchor").mockImplementation(() => {});

    const result = await execute("view.revealSelection");

    node.remove();
    expect(result.status).toBe("ok");
    expect(spy).toHaveBeenCalledWith(node);
    const s = useDawStore.getState();
    expect(s.selection).toEqual(SELECTION);
    expect(s.playheadSec).toBe(7);
    expect(s.timelineFollowPlayhead).toBe(true);
  });

  it("is disabled with no anchor on screen", async () => {
    const spy = vi.spyOn(reveal, "revealAnchor").mockImplementation(() => {});
    const result = await execute("view.revealSelection");
    expect(result.status).toBe("disabled");
    expect(spy).not.toHaveBeenCalled();
  });

  it("is disabled with nothing selected", async () => {
    useDawStore.setState({ selection: null });
    const result = await execute("view.revealSelection");
    expect(result.status).toBe("disabled");
  });

  it("seeks to the edit's start on the phone and leaves the selection alone", async () => {
    const edit = {
      id: "p1",
      timeline_start: 12,
      source_start: 12,
    };
    const project = useDawStore.getState().project;
    useDawStore.setState({
      shellBreakpoint: "phone",
      project: { ...project, pending_edits: [edit] } as never,
      selection: { kind: "pending", id: "p1", trackId: "t" },
    });
    const node = document.createElement("div");
    document.body.append(node);
    reveal.selectionAnchor.set({ current: node });
    const scroll = vi
      .spyOn(reveal, "revealAnchor")
      .mockImplementation(() => {});

    const result = await execute("view.revealSelection");

    node.remove();
    expect(result.status).toBe("ok");
    expect(useDawStore.getState().playheadSec).toBe(12);
    expect(useDawStore.getState().selection).toMatchObject({ id: "p1" });
    expect(scroll).not.toHaveBeenCalled();
  });
});
