import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveEdits, rejectEdits, waiveTranscriptRefine } from "../api";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { answerQuestions } from "../test/ask";
import {
  appliedEditRecord,
  COMMENTER_CAPABILITIES,
  clipRow,
  minimalProject,
} from "../test/fixtures";
import { parseHistoryEntryId } from "../types/project";
import { ApiError, TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { ImpactPanel } from "./ImpactPanel";

const { loadHostCommandCount } = vi.hoisted(() => ({
  loadHostCommandCount: vi.fn(async () => 1),
}));

vi.mock("../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandCount,
}));

vi.mock("../document/applyDocumentUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../document/applyDocumentUpdate")>()),
  refreshDocumentProject: vi.fn(async () => minimalProject()),
}));

vi.mock("../api", () => ({
  approveEdits: vi.fn(async () => ({
    queued: false,
    count: 1,
    historyHead: null,
  })),
  rejectEdits: vi.fn(async () => ({
    queued: false,
    count: 1,
    historyHead: null,
  })),
  waiveTranscriptRefine: vi.fn(),
}));

const blocked =
  "Transcript refine is required before focus/tighten/NL edits. Run podcast-transcript-refine.";

function project() {
  return minimalProject({
    pending_edits: [
      {
        id: "e1",
        track_id: "host",
        type: "remove",
        reason: "filler:um",
        source_start: 1,
        source_end: 2,
        source_start_timeline: 1,
        source_end_timeline: 2,
        timeline_start: 1,
        timeline_end: 2,
        timeline_spans: [{ start: 1, end: 2 }],
        mappable: true,
        crossfade_ms: null,
        boundary_mode: null,
        cut_confidence: null,
        review_required: true,
        harsh: true,
        applied: false,
        suggest_reason: null,
      },
    ],
    edit_impact: {
      pending_review_count: 1,
      total_removed_sec: 1,
      by_track_sec: { host: 1 },
    },
  });
}

describe("ImpactPanel transcript refine recovery", () => {
  beforeEach(() => {
    loadHostCommandCount.mockReset().mockResolvedValue(1);
    vi.mocked(approveEdits).mockReset().mockResolvedValue({
      queued: false,
      count: 1,
      historyHead: null,
    });
    vi.mocked(waiveTranscriptRefine).mockReset();
    useDawStore.getState().hydrate("/tmp/p.json", project());
    useDawStore.setState({ guestMode: null, shareCapabilities: [] });
    answerQuestions(true);
  });

  it.each([
    ["/tmp/p.json", null, null, true],
    [shareProjectKey("exact"), "edit", ["view", "edit"], true],
    [shareProjectKey("exact"), "comment", COMMENTER_CAPABILITIES, false],
  ] as const)(
    "gates exact bulk review at %s for guest mode %s",
    (path, guestMode, capabilities, canReview) => {
      const pending = project();
      pending.pending_edits[0].source_start = null;
      pending.pending_edits[0].source_end = null;
      pending.pending_edits[0].exact_range = {
        kind: "exact_range",
        intervals: [{ start: 1, end: 2 }],
        track_ids: ["host"],
        clips: [],
        media_seals: { host: "seal" },
      };
      useDawStore
        .getState()
        .hydrate(
          path,
          pending,
          guestMode,
          capabilities ? [...capabilities] : null,
        );
      render(<ImpactPanel />);
      const approveAll = screen.getByRole("button", { name: /Approve all/ });
      const rejectAll = screen.getByRole("button", { name: /Reject all/ });
      if (canReview) {
        expect(approveAll).toBeEnabled();
        expect(rejectAll).toBeEnabled();
        return;
      }
      expect(approveAll).toBeDisabled();
      expect(rejectAll).toBeDisabled();
      expect(approveAll).toHaveAccessibleDescription(
        "Only the host or an Editor can review suggestions.",
      );
      expect(
        screen
          .getAllByText("Only the host or an Editor can review suggestions.")
          .find((el) => !el.hidden),
      ).toBeVisible();
      expect(approveEdits).not.toHaveBeenCalled();
    },
  );

  it("marks each pending edit row with its id", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <ImpactPanel />
      </DawProvider>,
    );
    expect(
      screen.getByRole("button", {
        name: /host's cut at 0:01.0 · Filler word "um"/i,
      }),
    ).toHaveAttribute("data-pending-id", "e1");
  });

  it("lists and selects non-review pending edits while bulk remains review-required-only", async () => {
    const user = userEvent.setup();
    const pendingProject = project();
    pendingProject.pending_edits.push({
      ...pendingProject.pending_edits[0]!,
      id: "tiny-manual",
      source_start: 0.1,
      source_end: 0.2,
      source_start_timeline: 0.1,
      source_end_timeline: 0.2,
      timeline_start: 0.1,
      timeline_end: 0.2,
      timeline_spans: [{ start: 0.1, end: 0.2 }],
      reason: "manual:short",
      review_required: false,
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={pendingProject}>
        <ImpactPanel />
      </DawProvider>,
    );
    expect(
      screen.getByRole("button", {
        name: /host's cut at 0:01.0 · Filler word "um"/i,
      }),
    ).toBeInTheDocument();
    const tinyEdit = screen.getByRole("button", {
      name: /host's cut at 0:00.1 · manual:short/i,
    });
    expect(tinyEdit).toHaveAttribute("data-pending-id", "tiny-manual");
    await user.click(tinyEdit);
    expect(useDawStore.getState().selection).toEqual({
      kind: "pending",
      id: "tiny-manual",
      trackId: "host",
    });
    expect(
      screen.getByRole("button", { name: /Approve all \(1\)/ }),
    ).toBeInTheDocument();
  });

  it("says a bulk approval that is still sending is not done yet", async () => {
    const user = userEvent.setup();
    vi.mocked(approveEdits).mockResolvedValue({
      queued: true,
      count: null,
      historyHead: null,
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Still sending/,
    );
  });

  it("clears Still sending once the queued approval leaves the queue", async () => {
    const user = userEvent.setup();
    vi.mocked(approveEdits).mockResolvedValue({
      queued: true,
      count: null,
      historyHead: null,
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Still sending/,
    );
    loadHostCommandCount.mockResolvedValue(0);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), {
      timeout: 3000,
    });
  });

  it("offers a waiver after bulk approval is blocked without retrying approval", async () => {
    const user = userEvent.setup();
    vi.mocked(approveEdits).mockRejectedValue(
      new ApiError(blocked, TRANSCRIPT_REFINE_REQUIRED_CODE),
    );
    vi.mocked(waiveTranscriptRefine).mockResolvedValue();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project()}>
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(
      await screen.findByRole("button", { name: "Waive with reason" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Review the transcript or waive with a reason below/),
    ).toBeInTheDocument();
    expect(screen.queryByText(blocked)).toBeNull();
    await expectNoA11yViolations(container);
    await user.type(
      screen.getByRole("textbox", { name: "Waiver reason" }),
      "Reviewed",
    );
    await user.click(screen.getByRole("button", { name: "Waive with reason" }));
    expect(waiveTranscriptRefine).toHaveBeenCalledWith(
      "/tmp/p.json",
      "Reviewed",
    );
    expect(approveEdits).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Waive with reason" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Retry approval/);
    await expectNoA11yViolations(container);
  });

  it("does not show host waiver recovery for share guests", async () => {
    const user = userEvent.setup();
    vi.mocked(approveEdits).mockRejectedValue(new Error(blocked));
    render(
      <DawProvider
        projectPath={shareProjectKey("tok")}
        initialProject={project()}
        guestMode="edit"
        shareCapabilities={["view", "edit"]}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(await screen.findByText(blocked)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Waive with reason" }),
    ).toBeNull();
  });
});

describe("ImpactPanel bulk review", () => {
  const head = parseHistoryEntryId("h-7");

  function reviewProject() {
    const base = project();
    const waiting = (id: string, track: string, extra = {}) => ({
      ...base.pending_edits[0]!,
      id,
      track_id: track,
      ...extra,
    });
    return {
      ...base,
      pending_edits: [
        waiting("e1", "host"),
        waiting("e2", "host", {
          join_risk: { verdict: "review", label: "risky" },
        }),
        waiting("e3", "guest"),
        waiting("manual", "guest", { review_required: false }),
      ],
    };
  }

  function renderPanel() {
    return render(
      <DawProvider projectPath="/tmp/p.json" initialProject={reviewProject()}>
        <ImpactPanel />
      </DawProvider>,
    );
  }

  beforeEach(() => {
    loadHostCommandCount.mockReset().mockResolvedValue(1);
    vi.mocked(approveEdits).mockReset().mockResolvedValue({
      queued: false,
      count: 3,
      historyHead: head,
      held: [],
    });
    vi.mocked(rejectEdits).mockReset().mockResolvedValue({
      queued: false,
      count: 3,
      historyHead: head,
      held: [],
    });
    useDawStore.getState().hydrate("/tmp/p.json", reviewProject());
    useDawStore.setState({
      guestMode: null,
      shareCapabilities: [],
      feedbackToast: null,
    });
  });

  it("asks with the count, tracks and risk before approving, then offers one Undo", async () => {
    const user = userEvent.setup();
    const { asked } = answerQuestions(true);
    renderPanel();
    expect(screen.getByText("3 pending edits need review.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve all (3)" }));
    await waitFor(() => expect(approveEdits).toHaveBeenCalled());
    expect(vi.mocked(approveEdits).mock.calls[0]).toEqual([
      "/tmp/p.json",
      ["e1", "e2", "e3"],
      true,
      true,
    ]);
    expect(vi.mocked(approveEdits).mock.calls[0]?.[2]).toBe(true);
    expect(asked).toEqual([
      {
        kind: "confirm",
        title: "Approve 3 pending edits?",
        message:
          "Their cuts go into the timeline on 2 tracks. 1 is flagged risky. One Undo takes them back.",
        keepLabel: "Keep reviewing",
        actionLabel: "Approve 3",
        danger: false,
      },
    ]);
    const toast = useDawStore.getState().feedbackToast;
    expect(toast?.message).toBe("Approved 3 pending edits");
    expect(toast?.undo).toBe(head);
  });

  it("says how many applied and which cuts were held, naming each reason", async () => {
    const user = userEvent.setup();
    answerQuestions(true);
    vi.mocked(approveEdits).mockResolvedValue({
      queued: false,
      count: 2,
      historyHead: head,
      held: [
        {
          id: "e2",
          label: "Dani's cut at 12:03",
          reason: "Vicky is speaking where the session cut would remove it",
        },
      ],
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Approve all (3)" }));
    await waitFor(() =>
      expect(useDawStore.getState().feedbackToast?.message).toBe(
        "Applied 2, held 1. Dani's cut at 12:03 is held: Vicky is speaking where the session cut would remove it.",
      ),
    );
  });

  it("names only the first two held cuts when many are held", async () => {
    const user = userEvent.setup();
    answerQuestions(true);
    const cut = (n: number) => ({
      id: `h${n}`,
      label: `Cut ${n}`,
      reason: "r",
    });
    vi.mocked(approveEdits).mockResolvedValue({
      queued: false,
      count: 1,
      historyHead: head,
      held: [1, 2, 3, 4, 5].map(cut),
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Approve all (3)" }));
    await waitFor(() =>
      expect(useDawStore.getState().feedbackToast?.message).toBe(
        "Applied 1, held 5. Cut 1 is held: r. Cut 2 is held: r. 3 more are held in the list.",
      ),
    );
  });

  it("asks before rejecting, names it as discarding, and offers one Undo", async () => {
    const user = userEvent.setup();
    const { asked } = answerQuestions(true);
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Reject all (3)" }));
    await waitFor(() =>
      expect(rejectEdits).toHaveBeenCalledWith("/tmp/p.json", [
        "e1",
        "e2",
        "e3",
      ]),
    );
    expect(asked[0]).toMatchObject({
      title: "Reject 3 pending edits?",
      actionLabel: "Reject 3",
      danger: true,
    });
    const toast = useDawStore.getState().feedbackToast;
    expect(toast?.message).toBe("Rejected 3 pending edits");
    expect(toast?.undo).toBe(head);
  });

  it.each([
    ["Approve all (3)", approveEdits],
    ["Reject all (3)", rejectEdits],
  ] as const)(
    "changes nothing when %s is kept for review",
    async (name, api) => {
      const user = userEvent.setup();
      answerQuestions(null);
      renderPanel();
      await user.click(screen.getByRole("button", { name }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name })).toBeEnabled(),
      );
      expect(api).not.toHaveBeenCalled();
      expect(useDawStore.getState().feedbackToast).toBeNull();
    },
  );

  it("sends only the edits still waiting once the question is answered", async () => {
    vi.mocked(approveEdits).mockResolvedValueOnce({
      queued: false,
      count: 2,
      historyHead: head,
      held: [],
    });
    const user = userEvent.setup();
    answerQuestions(() => {
      const live = useDawStore.getState();
      useDawStore.setState({
        project: {
          ...live.project!,
          pending_edits: live.project!.pending_edits.filter(
            (edit) => edit.id !== "e2",
          ),
        },
      });
      return true;
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Approve all (3)" }));
    await waitFor(() => expect(approveEdits).toHaveBeenCalled());
    expect(vi.mocked(approveEdits).mock.calls[0]?.[1]).toEqual(["e1", "e3"]);
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      "Approved 2 pending edits",
    );
  });

  it("sends nothing when every edit was decided while the question was open", async () => {
    const user = userEvent.setup();
    answerQuestions(() => {
      const live = useDawStore.getState();
      useDawStore.setState({
        project: { ...live.project!, pending_edits: [] },
      });
      return true;
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Reject all (3)" }));
    await waitFor(() =>
      expect(useDawStore.getState().feedbackToast).toBeNull(),
    );
    expect(rejectEdits).not.toHaveBeenCalled();
  });

  it("shows what is running while the approval is in flight, then clears it", async () => {
    const user = userEvent.setup();
    answerQuestions(true);
    let finish: () => void = () => {};
    vi.mocked(approveEdits).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              queued: false,
              count: 3,
              historyHead: null,
            });
        }),
    );
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Approve all (3)" }));
    expect(await screen.findByRole("status", {})).toHaveTextContent(
      "Approving 3 edits…",
    );
    act(() => finish());
    await waitFor(() =>
      expect(screen.queryByText(/Approving 3 edits/)).not.toBeInTheDocument(),
    );
  });

  it("offers no Undo while the approval is still sending", async () => {
    const user = userEvent.setup();
    answerQuestions(true);
    vi.mocked(approveEdits).mockResolvedValue({
      queued: true,
      count: null,
      historyHead: null,
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Approve all (3)" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Still sending/,
    );
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("shows no toast and keeps the edits when approval fails", async () => {
    const user = userEvent.setup();
    answerQuestions(true);
    vi.mocked(approveEdits).mockRejectedValue(new Error("offline"));
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Approve all (3)" }));
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("passes axe with the bulk row, for the host and for a commenter", async () => {
    const { container, unmount } = renderPanel();
    await expectNoA11yViolations(container);
    unmount();
    const { container: guest } = render(
      <DawProvider
        projectPath={shareProjectKey("tok")}
        initialProject={reviewProject()}
        guestMode="comment"
        shareCapabilities={[...COMMENTER_CAPABILITIES]}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    await expectNoA11yViolations(guest);
  });
});

describe("ImpactPanel applied edits", () => {
  function projectWithApplied() {
    return minimalProject({
      clips: {
        tracks: {
          host: [
            clipRow({
              id: "c1",
              track_id: "host",
              source_start: 0,
              source_end: 2,
              timeline_start: 0,
              timeline_end: 2,
            }),
            clipRow({
              id: "c2",
              track_id: "host",
              source_start: 3,
              source_end: 9,
              timeline_start: 2,
              timeline_end: 8,
            }),
          ],
        },
        clip_count: 2,
      },
      applied_edits: {
        count: 2,
        records: [
          appliedEditRecord({
            id: "mapped",
            operation: "ripple_delete",
            track_ids: ["host"],
            source_start: null,
            source_end: null,
            params: { per_track_source: { host: [2, 3] } },
          }),
          appliedEditRecord({
            id: "legacy",
            operation: "ripple_delete",
            track_ids: ["host"],
            timeline_start: 0,
            timeline_end: 1334.8,
            source_start: null,
            source_end: null,
            params: {},
          }),
        ],
      },
    });
  }

  beforeEach(() => {
    loadHostCommandCount.mockReset().mockResolvedValue(1);
    useDawStore.getState().hydrate("/tmp/p.json", projectWithApplied());
    useDawStore.setState({ guestMode: null, shareCapabilities: [] });
  });

  it("shows the applied edits count in the summary", () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={projectWithApplied()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    expect(screen.getByText("Applied edits (2)")).toBeInTheDocument();
  });

  it("marks only the unmapped record as not on timeline", () => {
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={projectWithApplied()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    const mapped = screen.getByRole("button", {
      name: "Ripple delete: Shorten the pause · host",
    });
    expect(mapped.textContent).not.toContain("not on timeline");
    const legacy = screen.getByRole("button", {
      name: "Ripple delete: Shorten the pause · host · not on timeline",
    });
    expect(legacy).toBeInTheDocument();
  });

  it("selects the applied record on click", async () => {
    const user = userEvent.setup();
    render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={projectWithApplied()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Ripple delete: Shorten the pause · host",
      }),
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "applied",
      id: "mapped",
      trackId: "host",
    });
  });

  it("omits trackId when selecting a session-wide record", async () => {
    const user = userEvent.setup();
    const project = projectWithApplied();
    project.applied_edits.records.push(
      appliedEditRecord({
        id: "session",
        operation: "ripple_delete_clips",
        track_ids: [],
        reason: null,
      }),
    );
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <ImpactPanel />
      </DawProvider>,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Ripple delete clips · session · not on timeline",
      }),
    );
    expect(useDawStore.getState().selection).toStrictEqual({
      kind: "applied",
      id: "session",
    });
  });

  it("has no a11y violations with the applied list open", async () => {
    const { container } = render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={projectWithApplied()}
      >
        <ImpactPanel />
      </DawProvider>,
    );
    const details = container.querySelector("details.impact-applied");
    details?.setAttribute("open", "");
    await expectNoA11yViolations(container);
  });
});
