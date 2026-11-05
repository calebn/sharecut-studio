import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { clearClipboard } from "../../edit/clipboard";
import { useDawStore } from "../../state/dawStore";
import {
  EDIT_SELECTIONS,
  editFixtureProject,
  MIRA,
} from "../../test/actionBarFixtures";
import type { ProjectView, Selection } from "../../types/project";
import { EditActionBar } from "./EditActionBar";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  deleteSocialClip: vi.fn(async () => undefined),
  updateSocialClipDetails: vi.fn(async () => undefined),
}));
const playRange = vi.hoisted(() => vi.fn());
vi.mock("../../utils/playRange", () => ({ playTimelineRange: playRange }));

function project(): ProjectView {
  return {
    ...editFixtureProject(),
    chapters: [{ time: 3, title: "Intro" }],
    social_clips: [
      {
        id: "s1",
        track_id: MIRA,
        start: 2,
        end: 9,
        score: 0.8,
        title_suggestion: "Hook",
        approved: false,
        review_required: false,
      },
    ],
    envelopes: [
      {
        track_id: MIRA,
        parameter: "volume",
        points: [
          { id: "p1", time: 2, value: 1 },
          { id: "p2", time: 5, value: 0.5 },
        ],
      },
    ],
  };
}

function host(selection: Selection, extra: Record<string, unknown> = {}) {
  useDawStore.setState({
    project: project(),
    projectPath: "/tmp/episode",
    guestMode: null,
    shareCapabilities: null,
    stage: "edit",
    selection,
    rangeArmed: false,
    inspectorKey: null,
    playheadSec: 1,
    statusAnnouncement: "",
    ...extra,
  });
}

const dock = () => screen.getByRole("group", { name: "Edit actions" });
const object = () => dock().querySelector(".sys-actions-object");
const names = () =>
  within(dock())
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  clearClipboard();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("the phone dock names its object", () => {
  const cases: [string, Selection, string][] = [
    ["a clip", EDIT_SELECTIONS.clip, "Mira"],
    ["several clips", EDIT_SELECTIONS.clips, "3 clips"],
    ["a pending edit", EDIT_SELECTIONS.suggestion, "Suggestion"],
    [
      "an envelope point",
      { kind: "envelopePoint", trackId: MIRA, pointId: "p2" },
      "Mira point 2",
    ],
    ["a chapter", { kind: "chapter", id: "Intro", time: 3 }, "Chapter"],
    ["a social clip", { kind: "social", id: "s1" }, "Social clip"],
    ["a comment", EDIT_SELECTIONS.comment, "Comment"],
    ["words", EDIT_SELECTIONS.liveWords, "Word"],
    ["a range", EDIT_SELECTIONS.rangeOnAllTracks, "Range"],
  ];
  it.each(cases)(
    "shows an icon and a short name for %s",
    (_kind, selection, name) => {
      host(selection);
      render(<EditActionBar form="dock" root={null} />);
      expect(object()?.querySelector("svg")).not.toBeNull();
      expect(object()?.textContent).toBe(name);
    },
  );

  it("draws no object with nothing selected", () => {
    host(null);
    render(<EditActionBar form="dock" root={null} />);
    expect(object()).toBeNull();
  });
});

describe("the phone dock verbs for the marker kinds", () => {
  it("gives an envelope point Hear, Remove and the grip, and Hear plays around it", async () => {
    host({ kind: "envelopePoint", trackId: MIRA, pointId: "p2" });
    render(<EditActionBar form="dock" root={null} />);
    expect(names()).toEqual(["Inspect", "Hear", "Remove"]);
    await userEvent.click(screen.getByRole("button", { name: /^Hear/ }));
    expect(playRange).toHaveBeenCalledWith(
      expect.objectContaining({ start: 4, end: 6 }),
    );
  });

  it("gives a chapter Hear, Fix text and Remove, and Fix text opens the Inspector", async () => {
    host({ kind: "chapter", id: "Intro", time: 3 });
    render(<EditActionBar form="dock" root={null} />);
    expect(names()).toEqual(["Inspect", "Hear", "Fix text", "Remove"]);
    await userEvent.click(screen.getByRole("button", { name: /^Fix text/ }));
    expect(useDawStore.getState().inspectorKey).not.toBeNull();
  });

  it("gives a social clip Hear, Comment, Remove and a primary Approve", async () => {
    host({ kind: "social", id: "s1" });
    render(<EditActionBar form="dock" root={null} />);
    expect(names()).toEqual([
      "Inspect",
      "Hear",
      "Comment",
      "Remove",
      "Approve",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.updateSocialClipDetails).toHaveBeenCalledWith(
      "/tmp/episode",
      "s1",
      { approved: true },
    );
  });

  it("removes a social clip and clears the selection", async () => {
    host({ kind: "social", id: "s1" });
    render(<EditActionBar form="dock" root={null} />);
    await userEvent.click(screen.getByRole("button", { name: /^Remove/ }));
    expect(api.deleteSocialClip).toHaveBeenCalledWith("/tmp/episode", "s1");
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("keeps Approve and Remove away from a share that is not the host", async () => {
    host(
      { kind: "social", id: "s1" },
      {
        projectPath: "share:tok",
        guestMode: "edit",
        shareCapabilities: ["view", "play", "comment", "edit"],
      },
    );
    render(<EditActionBar form="dock" root={null} />);
    const approve = screen.queryByRole("button", { name: "Approve" });
    if (approve) await userEvent.click(approve);
    expect(api.updateSocialClipDetails).not.toHaveBeenCalled();
  });
});
