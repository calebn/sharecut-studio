import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { COMMANDS } from "./catalog";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";
import * as reveal from "./timelineReveal";

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
  useDawStore.setState({ isPlaying: false });
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
      breaksFollow: true,
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

  it("keeps the anchor of a dock that is still mounted when another dock releases its own", async () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    const a = { current: first };
    const b = { current: second };
    reveal.selectionAnchor.set(a);
    reveal.selectionAnchor.set(b);
    reveal.selectionAnchor.release(b);
    const spy = vi.spyOn(reveal, "revealAnchor").mockImplementation(() => {});

    const result = await execute("view.revealSelection");

    first.remove();
    second.remove();
    expect(result.status).toBe("ok");
    expect(spy).toHaveBeenCalledWith(first);
  });

  it("stops the playhead follow so playback does not page the view back", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    reveal.selectionAnchor.set({ current: node });
    vi.spyOn(reveal, "revealAnchor").mockImplementation(() => {});
    useDawStore.setState({ isPlaying: true, timelineFollowPlayhead: true });

    await execute("view.revealSelection");

    node.remove();
    expect(useDawStore.getState().timelineFollowPlayhead).toBe(false);
  });

  it("is disabled with no anchor on screen", async () => {
    const spy = vi.spyOn(reveal, "revealAnchor").mockImplementation(() => {});
    const result = await execute("view.revealSelection");
    expect(result.status).toBe("disabled");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not suspend the playhead follow when the phone has nowhere to seek", async () => {
    const project = useDawStore.getState().project;
    useDawStore.setState({
      shellBreakpoint: "phone",
      isPlaying: true,
      timelineFollowPlayhead: true,
      project: {
        ...project,
        pending_edits: [{ id: "p3", timeline_start: null, source_start: 9 }],
      } as never,
      selection: { kind: "pending", id: "p3", trackId: "t" },
    });
    const node = document.createElement("div");
    document.body.append(node);
    reveal.selectionAnchor.set({ current: node });

    const result = await execute("view.revealSelection");

    node.remove();
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().timelineFollowPlayhead).toBe(true);
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
      source_start: 5,
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

  it("has no place to seek an edit with no timeline time on the phone, and never uses its source time", async () => {
    const project = useDawStore.getState().project;
    useDawStore.setState({
      shellBreakpoint: "phone",
      project: {
        ...project,
        pending_edits: [{ id: "p2", timeline_start: null, source_start: 9 }],
      } as never,
      selection: { kind: "pending", id: "p2", trackId: "t" },
      playheadSec: 3,
    });
    const node = document.createElement("div");
    document.body.append(node);
    reveal.selectionAnchor.set({ current: node });

    const result = await execute("view.revealSelection");

    node.remove();
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().playheadSec).toBe(3);
  });

  it("brings back the latest registered anchor when two docks are mounted", async () => {
    const older = document.createElement("div");
    const newer = document.createElement("div");
    document.body.append(older, newer);
    reveal.selectionAnchor.set({ current: older });
    reveal.selectionAnchor.set({ current: newer });
    const spy = vi.spyOn(reveal, "revealAnchor").mockImplementation(() => {});

    await execute("view.revealSelection");

    older.remove();
    newer.remove();
    expect(spy).toHaveBeenCalledWith(newer);
  });
});
