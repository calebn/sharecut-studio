import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostFetch } from "../api/documentTransport";
import { makeRangeTarget } from "../edit/rangeSelection";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
  wavResponse,
} from "../test/fixtures";
import type { PendingEditView, ProjectView } from "../types/project";
import type { PreviewMode } from "../utils/playRange";
import { PendingPreviewFooter } from "./PendingPreviewFooter";

vi.mock("../api/documentTransport", () => ({ hostFetch: vi.fn() }));

const SPLIT_REASON = "A split does not change the mix until you delete a side.";

function baseProject(): ProjectView {
  return minimalProject({
    tracks: [sampleTrack({ range_media_seal: "seal" })],
    clips: {
      tracks: {
        host: [
          clipRow({
            track_id: "host",
            source_start: 0,
            source_end: 20,
            timeline_start: 0,
            timeline_end: 20,
          }),
        ],
      },
      clip_count: 1,
    },
  });
}

function exactEdit(project: ProjectView): PendingEditView {
  const target = makeRangeTarget(
    project,
    [
      { start: 11, end: 12 },
      { start: 13, end: 14 },
    ],
    ["host"],
  )!;
  return pendingEditView({
    id: "exact",
    track_id: "host",
    track_ids: ["host"],
    source_start: null,
    source_end: null,
    timeline_start: 11,
    timeline_end: 14,
    exact_range: {
      ...target,
      clips: target.clips.map(
        ({
          id,
          track_id,
          source_start,
          source_end,
          timeline_start,
          source_id,
          fade_in_ms,
          fade_out_ms,
          join_in_mode,
          mute_regions,
        }) => ({
          id,
          track_id,
          source_start,
          source_end,
          timeline_start,
          source_id,
          fade_in_ms,
          fade_out_ms,
          join_in_mode,
          mute_regions,
        }),
      ),
    },
  });
}

function ordinaryEdit(overrides: Partial<PendingEditView> = {}) {
  return pendingEditView({
    id: "cut",
    track_id: "host",
    track_ids: ["host"],
    source_start: 5,
    source_end: 6,
    source_start_timeline: 5,
    source_end_timeline: 6,
    timeline_start: 5,
    timeline_end: 6,
    timeline_spans: [{ start: 5, end: 6 }],
    scope: "session",
    ...overrides,
  });
}

function setup({
  path = "/tmp/p.json",
  mode = "suggested" as PreviewMode,
  edit: makeEdit = exactEdit,
}: {
  path?: string;
  mode?: PreviewMode;
  edit?: (project: ProjectView) => PendingEditView;
} = {}) {
  const project = baseProject();
  const edit = makeEdit(project);
  project.pending_edits = [edit];
  useDawStore.getState().hydrate(path, project);
  useDawStore.setState({
    guestMode: path.startsWith("share:") ? "edit" : null,
    shareCapabilities: ["view", "edit"],
  });
  const onError = vi.fn();
  const rendered = render(
    <PendingPreviewFooter
      edit={edit}
      projectPath={path}
      seekSec={edit.timeline_start!}
      mode={mode}
      onModeChange={vi.fn()}
      onError={onError}
    />,
  );
  return { project, edit, onError, ...rendered };
}

const playButton = () => screen.getByRole("button", { name: "Play around" });

async function settle() {
  await waitFor(() =>
    expect(playButton()).not.toHaveAttribute(
      "title",
      "Preparing full mix preview",
    ),
  );
}

describe("pending preview footer", () => {
  beforeEach(() => {
    vi.mocked(hostFetch)
      .mockReset()
      .mockImplementation(async () => wavResponse(1.25));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => wavResponse(1.25)),
    );
    URL.createObjectURL = vi.fn(() => "blob:pending-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("plays the server's Suggested render for an ordinary pending remove", async () => {
    vi.mocked(hostFetch).mockImplementation(async () => wavResponse(1.918));
    setup({ edit: () => ordinaryEdit() });
    fireEvent.click(playButton());
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    expect(hostFetch).toHaveBeenCalledWith(
      `/api/pending-preview?edit_id=cut&mode=suggested&path=${encodeURIComponent("/tmp/p.json")}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(useDawStore.getState().sourcePreview).toMatchObject({
      ownerId: "pending:cut",
      media: { kind: "rendered", url: "blob:pending-preview" },
      startSec: 0,
      endSec: 1.918,
    });
  });

  it.each(["current", "suggested", "ab"] as const)(
    "requests the host %s full mix for an exact range",
    async (mode) => {
      setup({ mode });
      fireEvent.click(playButton());
      await waitFor(() =>
        expect(useDawStore.getState().sourcePreview).not.toBeNull(),
      );
      expect(hostFetch).toHaveBeenCalledWith(
        `/api/pending-preview?edit_id=exact&mode=${mode}&path=${encodeURIComponent("/tmp/p.json")}`,
        expect.anything(),
      );
      expect(useDawStore.getState().sourcePreview).toMatchObject({
        ownerId: "pending:exact",
        endSec: 1.25,
      });
    },
  );

  it("offers Suggested for a mute and fetches its render", async () => {
    setup({ edit: () => ordinaryEdit({ id: "mute", type: "mute" }) });
    expect(screen.getByRole("button", { name: "Suggested" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "A/B" })).toBeEnabled();
    fireEvent.click(playButton());
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview?.ownerId).toBe(
        "pending:mute",
      ),
    );
    expect(hostFetch).toHaveBeenCalledWith(
      expect.stringContaining("edit_id=mute&mode=suggested"),
      expect.anything(),
    );
  });

  it("shows a split's reason and never fetches Suggested", () => {
    setup({
      edit: () =>
        ordinaryEdit({
          id: "split",
          type: "split",
          source_end: 5,
          timeline_end: 5,
          suggest_reason: SPLIT_REASON,
        }),
    });
    expect(screen.getByRole("button", { name: "Suggested" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "A/B" })).toBeDisabled();
    expect(screen.getByText(SPLIT_REASON)).toBeInTheDocument();
    expect(playButton()).toBeDisabled();
    expect(playButton()).toHaveAttribute("title", SPLIT_REASON);
    fireEvent.click(playButton());
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("plays Current for a split", async () => {
    setup({
      mode: "current",
      edit: () =>
        ordinaryEdit({
          id: "split",
          type: "split",
          source_end: 5,
          timeline_end: 5,
          suggest_reason: SPLIT_REASON,
        }),
    });
    fireEvent.click(playButton());
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    expect(hostFetch).toHaveBeenCalledWith(
      expect.stringContaining("edit_id=split&mode=current"),
      expect.anything(),
    );
  });

  it("does not play an ordinary edit whose bounds moved while it rendered", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(hostFetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { project, edit, onError } = setup({ edit: () => ordinaryEdit() });
    fireEvent.click(playButton());
    act(() =>
      useDawStore.setState({
        project: {
          ...project,
          pending_edits: [{ ...edit, source_end: 6.5, timeline_end: 6.5 }],
        },
      }),
    );
    await act(async () => finish(wavResponse(1)));
    await settle();
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith(
      "This edit changed while its preview rendered. Play it again.",
    );
  });

  it("does not play an edit approved while it rendered", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(hostFetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { project } = setup({ edit: () => ordinaryEdit() });
    fireEvent.click(playButton());
    act(() =>
      useDawStore.setState({ project: { ...project, pending_edits: [] } }),
    );
    await act(async () => finish(wavResponse(1)));
    await settle();
    expect(useDawStore.getState().sourcePreview).toBeNull();
  });

  it("reports a server refusal inline", async () => {
    vi.mocked(hostFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "premix missing" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { onError } = setup({ edit: () => ordinaryEdit() });
    fireEvent.click(playButton());
    await settle();
    expect(onError).toHaveBeenLastCalledWith("premix missing");
    expect(useDawStore.getState().sourcePreview).toBeNull();
  });

  it("releases its preview and frees the audio on unmount", async () => {
    const { unmount } = setup({ edit: () => ordinaryEdit() });
    fireEvent.click(playButton());
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    unmount();
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pending-preview");
  });

  it("uses the token-scoped full mix route for a guest with view/play", async () => {
    setup({ path: shareProjectKey("token"), edit: () => ordinaryEdit() });
    fireEvent.click(playButton());
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "/daw/pending-preview?edit_id=cut&mode=suggested",
      ),
      expect.anything(),
    );
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("keeps Play disabled with a reason when a share loses playback", () => {
    setup({ path: shareProjectKey("token") });
    act(() => useDawStore.setState({ shareCapabilities: ["edit"] }));
    expect(playButton()).toBeDisabled();
    expect(playButton()).toHaveAttribute(
      "title",
      "This share cannot play audio",
    );
  });

  it.each(["object_order", "islands", "lanes"])(
    "checks exact range identity after deferred %s changes",
    async (change) => {
      let finish!: (response: Response) => void;
      vi.mocked(hostFetch).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const { project, edit } = setup();
      fireEvent.click(playButton());
      const target = edit.exact_range!;
      const updated =
        change === "object_order"
          ? (Object.fromEntries(
              Object.entries(target).reverse(),
            ) as typeof target)
          : change === "islands"
            ? { ...target, intervals: [target.intervals[0]] }
            : { ...target, track_ids: ["other"] };
      act(() =>
        useDawStore.setState({
          project: {
            ...project,
            pending_edits: [{ ...edit, exact_range: updated }],
          },
        }),
      );
      await act(async () => finish(wavResponse(1)));
      await settle();
      if (change === "object_order")
        expect(useDawStore.getState().sourcePreview).not.toBeNull();
      else expect(useDawStore.getState().sourcePreview).toBeNull();
    },
  );

  it.each(["geometry", "mix", "permission"])(
    "discards deferred audio after %s changes",
    async (change) => {
      let finish!: (response: Response) => void;
      vi.mocked(hostFetch).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const { project } = setup({ edit: () => ordinaryEdit() });
      fireEvent.click(playButton());
      act(() => {
        if (change === "geometry")
          useDawStore.setState({
            project: {
              ...project,
              clips: {
                ...project.clips,
                tracks: {
                  host: [
                    {
                      ...project.clips.tracks.host[0],
                      timeline_start: 1,
                      timeline_end: 21,
                    },
                  ],
                },
              },
            },
          });
        if (change === "mix")
          useDawStore.setState({
            project: {
              ...project,
              tracks: [{ ...project.tracks[0], fader_db: -12 }],
            },
          });
        if (change === "permission")
          useDawStore.setState({
            guestMode: "edit",
            shareCapabilities: ["edit"],
          });
      });
      await act(async () => finish(wavResponse(1)));
      await settle();
      expect(useDawStore.getState().sourcePreview).toBeNull();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    },
  );
});
