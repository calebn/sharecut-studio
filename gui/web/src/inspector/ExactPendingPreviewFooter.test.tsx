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
} from "../test/fixtures";
import type { PreviewMode } from "../utils/playRange";
import { ExactPendingPreviewFooter } from "./ExactPendingPreviewFooter";

vi.mock("../api/documentTransport", () => ({ hostFetch: vi.fn() }));

function setup(path = "/tmp/p.json", mode: PreviewMode = "suggested") {
  const project = minimalProject({
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
  const target = makeRangeTarget(
    project,
    [
      { start: 11, end: 12 },
      { start: 13, end: 14 },
    ],
    ["host"],
  )!;
  const edit = {
    ...pendingEditView(),
    id: "exact",
    source_start: null,
    source_end: null,
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
    can_skip: true,
  };
  project.pending_edits = [edit];
  useDawStore.getState().hydrate(path, project);
  useDawStore.setState({
    guestMode: path.startsWith("share:") ? "edit" : null,
    shareCapabilities: ["view", "edit"],
  });
  const onError = vi.fn();
  const rendered = render(
    <ExactPendingPreviewFooter
      edit={edit}
      projectPath={path}
      mode={mode}
      onModeChange={vi.fn()}
      onError={onError}
    />,
  );
  return { project, edit, onError, ...rendered };
}

describe("exact pending full mix preview", () => {
  beforeEach(() => {
    vi.mocked(hostFetch)
      .mockReset()
      .mockResolvedValue(new Response(new Blob(["wav"]), { status: 200 }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(new Blob(["wav"]), { status: 200 })),
    );
    URL.createObjectURL = vi.fn(() => "blob:exact-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it.each(["current", "suggested", "ab"] as const)(
    "requests host %s full mix and never installs a hull skip",
    async (mode) => {
      setup("/tmp/p.json", mode);
      fireEvent.click(screen.getByRole("button", { name: "Play around" }));
      await waitFor(() =>
        expect(useDawStore.getState().sourcePreview).not.toBeNull(),
      );
      expect(hostFetch).toHaveBeenCalledWith(
        expect.stringContaining(
          `/api/pending-preview?edit_id=exact&mode=${mode}&path=`,
        ),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(useDawStore.getState().sourcePreview).toMatchObject({
        ownerId: "pending:exact",
        startSec: 0,
        endSec: mode === "ab" ? 8.4 : 4,
      });
      expect(useDawStore.getState().playSkipStartSec).toBeNull();
    },
  );

  it("uses the token-scoped full mix route for a guest with view/play", async () => {
    setup(shareProjectKey("token"));
    fireEvent.click(screen.getByRole("button", { name: "Play around" }));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "/daw/pending-preview?edit_id=exact&mode=suggested",
      ),
      expect.anything(),
    );
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("keeps Play disabled with a reason when a share loses playback", () => {
    setup(shareProjectKey("token"));
    act(() => useDawStore.setState({ shareCapabilities: ["edit"] }));
    expect(screen.getByRole("button", { name: "Play around" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Play around" })).toHaveAttribute(
      "title",
      "This share cannot play audio",
    );
  });

  it.each(["object_order", "islands", "lanes"])(
    "checks pending identity after deferred %s changes",
    async (change) => {
      let finish!: (response: Response) => void;
      vi.mocked(hostFetch).mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const { project, edit } = setup();
      fireEvent.click(screen.getByRole("button", { name: "Play around" }));
      const target = edit.exact_range;
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
      await act(async () =>
        finish(new Response(new Blob(["wav"]), { status: 200 })),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Play around" }),
        ).not.toHaveAttribute("title", "Preparing full mix preview"),
      );
      if (change === "object_order")
        expect(useDawStore.getState().sourcePreview).not.toBeNull();
      else expect(useDawStore.getState().sourcePreview).toBeNull();
    },
  );

  it.each(["geometry", "mix", "permission"])(
    "discards deferred audio after %s changes",
    async (change) => {
      let finish!: (response: Response) => void;
      const gate = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      vi.mocked(hostFetch).mockReturnValueOnce(gate);
      const { project } = setup();
      fireEvent.click(screen.getByRole("button", { name: "Play around" }));
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
      await act(async () =>
        finish(new Response(new Blob(["wav"]), { status: 200 })),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Play around" }),
        ).not.toHaveAttribute("title", "Preparing full mix preview"),
      );
      expect(useDawStore.getState().sourcePreview).toBeNull();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    },
  );
});
