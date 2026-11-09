import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { transcriptWordPresenceAnchor } from "../../../presence/anchors";
import { useDawStore } from "../../../state/dawStore";
import { sampleTrack, sessionRoster } from "../../../test/fixtures";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import type { EditBoundaryView, PendingEditView } from "../../../types/project";
import type { SessionClient } from "../../../types/session";
import { ScriptHost } from "./ScriptHost";

const boundary = {
  id: "eb:c1:c2",
  track_id: "host",
  left_clip_id: "c1",
  right_clip_id: "c2",
  timeline_join_sec: 12.5,
  has_cutaway: true,
  cutaway_source_start: 12.5,
  cutaway_source_end: 14,
  cutaway_word_ids: [
    {
      track_id: "host",
      source_id: null,
      word_index: -3,
      text: "uh",
      start: 12.5,
      end: 12.9,
    },
  ],
} as unknown as EditBoundaryView;

const suggestion = {
  id: "p1",
  track_id: "host",
  type: "remove",
  author: "share:abc",
  source_start: 13,
  source_end: 13.6,
  applied: false,
} as unknown as PendingEditView;

const seam = () =>
  document.querySelector<HTMLElement>(".sys-script-pill button");
const run = () => screen.getByRole("button", { name: /^Suggested cut/ });

beforeEach(() => {
  seedScript({
    utterances: [
      scriptUtterance("host", "Maya", [
        scriptWord("Welcome", 0, 12),
        scriptWord("friends", 3, 12.5),
        scriptWord("again", 4, 13.2),
      ]),
    ],
    project: {
      tracks: [
        sampleTrack({ id: "host", speaker: "Maya" }),
        sampleTrack({ id: "guest", speaker: "Anneke" }),
      ],
      edit_boundaries: [boundary],
      pending_edits: [suggestion],
    },
  });
  useDawStore.setState({
    joinMutationInFlight: false,
    localClientId: "me",
    sessionClients: sessionRoster([]),
  });
});

describe("ScriptHost seams", () => {
  it("presses the pill of the seam the Timeline selected", () => {
    render(<ScriptHost />);
    expect(seam()).toHaveAttribute("aria-pressed", "false");
    act(() => {
      useDawStore.getState().setSelection({
        kind: "seam",
        id: "eb:c1:c2",
        trackId: "host",
      });
    });
    expect(seam()).toHaveAttribute("aria-pressed", "true");
  });

  it("does not press the pill for another seam", () => {
    render(<ScriptHost />);
    act(() => {
      useDawStore.getState().setSelection({
        kind: "seam",
        id: "eb:c2:c3",
        trackId: "host",
      });
    });
    expect(seam()).toHaveAttribute("aria-pressed", "false");
  });

  it("selects the seam by its boundary id when its pill is clicked", async () => {
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toEqual({
      kind: "seam",
      id: "eb:c1:c2",
      trackId: "host",
    });
    expect(seam()).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the seam selected on a repeat click", async () => {
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toEqual({
      kind: "seam",
      id: "eb:c1:c2",
      trackId: "host",
    });
    expect(seam()).toHaveAttribute("aria-pressed", "true");
  });

  it("replaces a words selection with the seam", async () => {
    render(<ScriptHost />);
    useDawStore.getState().setSelection({
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 0,
    });
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toMatchObject({ kind: "seam" });
  });

  it("clears the selected seam on Escape", async () => {
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    act(() => seam()?.focus());
    await userEvent.keyboard("{Escape}");
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("does not let a viewer select a seam", async () => {
    seedScript({
      projectPath: "share:viewer",
      shareCapabilities: ["play", "view"],
      project: { edit_boundaries: [boundary], pending_edits: [suggestion] },
    });
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toBeNull();
  });
});

describe("ScriptHost suggestions", () => {
  it("selects the pending edit as the timeline does", async () => {
    render(<ScriptHost />);
    expect(run()).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(run());
    expect(useDawStore.getState().selection).toEqual({
      kind: "pending",
      id: "p1",
      trackId: "host",
    });
    expect(run()).toHaveAttribute("aria-pressed", "true");
  });

  it("draws a pending edit selected elsewhere", () => {
    render(<ScriptHost />);
    act(() =>
      useDawStore
        .getState()
        .setSelection({ kind: "pending", id: "p1", trackId: "host" }),
    );
    expect(run()).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ScriptHost presence carets", () => {
  const remote = (
    id: string,
    meta: NonNullable<SessionClient["meta"]>,
  ): SessionClient => ({
    client_id: id,
    role: "viewer",
    last_seen_ns: Date.now() * 1e6,
    meta,
  });
  const carets = () =>
    Array.from(document.querySelectorAll(".sys-script-caret:not([data-own])"));

  it("draws other people at their word and not the local user", () => {
    useDawStore.setState({
      sessionClients: sessionRoster([
        remote("me", {
          display_name: "Me",
          cursor: {
            anchor: transcriptWordPresenceAnchor("host", null, 0),
          },
        }),
        remote("ada", {
          display_name: "Ada",
          color_index: 2,
          cursor: { anchor: transcriptWordPresenceAnchor("host", null, 3) },
        }),
        remote("bo", {
          display_name: "Bo",
          selection: {
            kind: "transcriptWord",
            track_id: "host",
            word_index: 4,
          },
        }),
        remote("cy", { display_name: "Cy", cursor: { anchor: "audition:fx" } }),
      ]),
    });
    render(<ScriptHost />);
    expect(carets()).toHaveLength(2);
    expect(screen.getByText("Ada's cursor")).toBeInTheDocument();
    expect(screen.getByText("Bo's cursor")).toBeInTheDocument();
    expect(screen.queryByText("Me's cursor")).toBeNull();
    expect(screen.queryByText("Cy's cursor")).toBeNull();
  });
});
