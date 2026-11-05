import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostFetch } from "../../api/documentTransport";
import {
  playPendingPreview,
  warmPendingPreview,
} from "../../audio/pendingPreview";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
  wavResponse,
} from "../../test/fixtures";
import { usePendingEditWarm } from "./usePendingEditWarm";

vi.mock("../../api/documentTransport", () => ({ hostFetch: vi.fn() }));
vi.mock("../../audio/pendingPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../audio/pendingPreview")>()),
  warmPendingPreview: vi.fn(),
}));

function Harness({ path, editId }: { path: string; editId: string }) {
  usePendingEditWarm(path, editId, true);
  return null;
}

function seed(path = "/tmp/p.json") {
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
  project.pending_edits = [
    pendingEditView({
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
    }),
  ];
  useDawStore.getState().hydrate(path, project);
  useDawStore.setState({
    guestMode: path.startsWith("share:") ? "edit" : null,
    shareCapabilities: ["view", "edit"],
  });
}

const revokeObjectURL = vi.fn();

describe("usePendingEditWarm", () => {
  beforeEach(() => {
    vi.mocked(warmPendingPreview).mockClear();
    vi.mocked(hostFetch)
      .mockReset()
      .mockImplementation(async () => wavResponse(1.25));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => wavResponse(1.25)),
    );
    URL.createObjectURL = vi.fn(() => "blob:pending-preview");
    revokeObjectURL.mockClear();
    URL.revokeObjectURL = revokeObjectURL;
  });

  it("warms the host for the edit it shows, again once the mix changes", async () => {
    seed();
    render(<Harness path="/tmp/p.json" editId="cut" />);
    await waitFor(
      () =>
        expect(warmPendingPreview).toHaveBeenCalledWith("/tmp/p.json", "cut"),
      { timeout: 3000 },
    );
    vi.mocked(warmPendingPreview).mockClear();
    act(() => {
      const project = useDawStore.getState().project!;
      useDawStore.getState().hydrate("/tmp/p.json", {
        ...project,
        tracks: project.tracks.map((track) => ({ ...track, fader_db: -6 })),
      });
    });
    await waitFor(() => expect(warmPendingPreview).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
  });

  it("does not warm where the share cannot play audio", async () => {
    seed(shareProjectKey("token"));
    useDawStore.setState({ shareCapabilities: ["edit"] });
    render(<Harness path={shareProjectKey("token")} editId="cut" />);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(warmPendingPreview).not.toHaveBeenCalled();
  });

  it("releases the preview and frees the audio on unmount", async () => {
    seed();
    const { unmount } = render(<Harness path="/tmp/p.json" editId="cut" />);
    await playPendingPreview("/tmp/p.json", "cut", "suggested");
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    unmount();
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pending-preview");
  });

  it("releases the previous edit's audio when the edit id changes", async () => {
    seed();
    const { rerender } = render(<Harness path="/tmp/p.json" editId="cut" />);
    await playPendingPreview("/tmp/p.json", "cut", "suggested");
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    rerender(<Harness path="/tmp/p.json" editId="other" />);
    expect(useDawStore.getState().sourcePreview).toBeNull();
  });
});
