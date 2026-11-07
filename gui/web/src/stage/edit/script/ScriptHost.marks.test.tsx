import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { transcriptWordPresenceAnchor } from "../../../presence/anchors";
import { useDawStore } from "../../../state/dawStore";
import {
  appliedEditRecord,
  clipRow,
  sampleTrack,
  sessionRoster,
} from "../../../test/fixtures";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import {
  appliedEditTicks,
  seamTickAtJoin,
} from "../../../timeline/appliedEditTicks";
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

function installAppliedSeam(recordId = "cut-at-seam", trackIds = ["host"]) {
  const project = useDawStore.getState().project;
  if (!project) throw new Error("Script project missing");
  const clips = [
    clipRow({
      id: "c1",
      track_id: "host",
      source_start: 0,
      source_end: 12.5,
      timeline_start: 0,
      timeline_end: 12.5,
    }),
    clipRow({
      id: "c2",
      track_id: "host",
      source_start: 14,
      source_end: 20,
      timeline_start: 12.5,
      timeline_end: 18.5,
    }),
  ];
  const record = appliedEditRecord({
    id: recordId,
    track_ids: trackIds,
    source_start: 12.5,
    source_end: 14,
    timeline_start: 12.5,
    timeline_end: 12.5,
  });
  useDawStore.setState({
    project: {
      ...project,
      clips: { tracks: { host: clips }, clip_count: 2 },
      applied_edits: { count: 1, records: [record] },
    },
  });
  return { clips, record };
}

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
    openJoinId: null,
    joinMutationInFlight: false,
    localClientId: "me",
    sessionClients: sessionRoster([]),
  });
});

describe("ScriptHost seams", () => {
  it("keeps the Script seam visibly selected for the Timeline's applied-record selection", () => {
    const { clips, record } = installAppliedSeam();
    expect(
      seamTickAtJoin(appliedEditTicks([record], "host", clips), {
        sec: 12.5,
      })?.recordId,
    ).toBe("cut-at-seam");
    render(<ScriptHost />);
    act(() => {
      useDawStore.getState().setSelection({
        kind: "applied",
        id: "cut-at-seam",
        trackId: "host",
      });
      useDawStore.getState().setOpenJoinId("c2");
    });
    expect(seam()).toHaveAttribute("aria-pressed", "true");
  });

  it("does not project an unrelated applied record", () => {
    installAppliedSeam();
    render(<ScriptHost />);
    act(() => {
      useDawStore.getState().setSelection({
        kind: "applied",
        id: "another-record",
        trackId: "host",
      });
      useDawStore.getState().setOpenJoinId("c2");
    });
    expect(seam()).toHaveAttribute("aria-pressed", "false");
  });

  it("does not project the matching record selected on another track", () => {
    installAppliedSeam();
    render(<ScriptHost />);
    act(() => {
      useDawStore.getState().setSelection({
        kind: "applied",
        id: "cut-at-seam",
        trackId: "guest",
      });
      useDawStore.getState().setOpenJoinId("c2");
    });
    expect(seam()).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the no-record join toggle fallback", async () => {
    render(<ScriptHost />);
    useDawStore.getState().setSelection({
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 0,
    });
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().openJoinId).toBe("c2");
  });

  it("selects the Timeline applied record when clicking its Script seam", async () => {
    installAppliedSeam();
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toEqual({
      kind: "applied",
      id: "cut-at-seam",
      trackId: "host",
    });
    expect(useDawStore.getState().openJoinId).toBe("c2");
    expect(seam()).toHaveAttribute("aria-pressed", "true");
  });

  it("retains a record-backed selection when a repeat click closes its join", async () => {
    installAppliedSeam();
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toEqual({
      kind: "applied",
      id: "cut-at-seam",
      trackId: "host",
    });
    expect(useDawStore.getState().openJoinId).toBeNull();
    expect(seam()).toHaveAttribute("aria-pressed", "false");
  });

  it("uses replacement project records for both projection and a later click", async () => {
    const { clips } = installAppliedSeam("old-record");
    render(<ScriptHost />);
    act(() => {
      useDawStore.getState().setSelection({
        kind: "applied",
        id: "old-record",
        trackId: "host",
      });
      useDawStore.getState().setOpenJoinId("c2");
    });
    expect(seam()).toHaveAttribute("aria-pressed", "true");
    const project = useDawStore.getState().project;
    if (!project) throw new Error("Script project missing");
    const replacement = appliedEditRecord({
      id: "new-record",
      track_ids: ["host"],
      source_start: 12.5,
      source_end: 14,
      timeline_start: 12.5,
      timeline_end: 12.5,
    });
    act(() =>
      useDawStore.setState({
        project: {
          ...project,
          clips: { tracks: { host: clips }, clip_count: 2 },
          applied_edits: { count: 1, records: [replacement] },
        },
        openJoinId: null,
      }),
    );
    expect(seam()).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toEqual({
      kind: "applied",
      id: "new-record",
      trackId: "host",
    });
    expect(useDawStore.getState().openJoinId).toBe("c2");
  });

  it("opens the join the timeline opens for that boundary", async () => {
    render(<ScriptHost />);
    useDawStore.getState().setSelection({
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 0,
    });
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().openJoinId).toBe("c2");
    expect(useDawStore.getState().selection).toBeNull();
    expect(seam()).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the join when its seam is clicked again", async () => {
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().openJoinId).toBe("c2");
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().openJoinId).toBeNull();
  });

  it("leaves the selection and join alone while a join edit is in flight", async () => {
    const prior = {
      kind: "transcriptRange" as const,
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 0,
    };
    useDawStore.setState({
      joinMutationInFlight: true,
      selection: prior,
      openJoinId: "existing-join",
    });
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().selection).toEqual(prior);
    expect(useDawStore.getState().openJoinId).toBe("existing-join");
  });

  it("draws a join the timeline opened as the selected seam, and Escape closes it", async () => {
    render(<ScriptHost />);
    expect(seam()).toHaveAttribute("aria-pressed", "false");
    act(() => useDawStore.getState().setOpenJoinId("c2"));
    expect(seam()).toHaveAttribute("aria-pressed", "true");
    act(() => seam()?.focus());
    await userEvent.keyboard("{Escape}");
    expect(useDawStore.getState().openJoinId).toBeNull();
  });

  it("does not let a viewer select a seam", async () => {
    seedScript({
      projectPath: "share:viewer",
      shareCapabilities: ["play", "view"],
      project: { edit_boundaries: [boundary], pending_edits: [suggestion] },
    });
    render(<ScriptHost />);
    await userEvent.click(seam() as HTMLElement);
    expect(useDawStore.getState().openJoinId).toBeNull();
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
