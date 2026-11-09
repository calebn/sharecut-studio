import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTrackMetaCommand } from "../../api";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { Selection } from "../../types/project";
import { inspectorRename } from "./inspectorRename";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  setTrackMetaCommand: vi.fn(),
}));
vi.mock("../../document/applyDocumentUpdate", async (original) => ({
  ...(await original<typeof import("../../document/applyDocumentUpdate")>()),
  redisplayDrafts: vi.fn(),
}));

const PATH = "/tmp/ep.json";
const project = minimalProject({
  tracks: [
    sampleTrack({ id: "host", label: "Host" }),
    sampleTrack({ id: "guest", label: "Guest" }),
  ],
});
const track: Selection = { kind: "track", trackId: "host" };

function hydrateHost() {
  useDawStore.getState().hydrate(PATH, project);
  return useDawStore.getState().project;
}

beforeEach(() => {
  vi.clearAllMocks();
  useDawStore.setState({ feedbackToast: null });
});

describe("inspectorRename", () => {
  it("sends the new label once for a host on one track", () => {
    vi.mocked(setTrackMetaCommand).mockResolvedValue({});
    const rename = inspectorRename(track, hydrateHost());
    rename?.("Narrator");
    expect(setTrackMetaCommand).toHaveBeenCalledExactlyOnceWith(PATH, "host", {
      label: "Narrator",
    });
  });

  it("is withheld from a viewer share, two tracks and a missing track", () => {
    useDawStore.getState().hydrate(shareProjectKey("tok"), project, "view");
    expect(
      inspectorRename(track, useDawStore.getState().project),
    ).toBeUndefined();
    const hosted = hydrateHost();
    expect(
      inspectorRename(
        { kind: "track", trackId: "host", trackIds: ["host", "guest"] },
        hosted,
      ),
    ).toBeUndefined();
    expect(
      inspectorRename({ kind: "track", trackId: "gone" }, hosted),
    ).toBeUndefined();
  });

  it.each<NonNullable<Selection>["kind"]>([
    "clip",
    "transcriptRange",
    "pending",
    "seam",
    "chapter",
    "social",
    "comment",
    "bleedAttenuation",
    "envelope",
    "envelopePoint",
    "range",
  ])("is withheld from a %s selection", (kind) => {
    const selection = { kind, trackId: "host", id: "x" } as Selection;
    expect(inspectorRename(selection, hydrateHost())).toBeUndefined();
  });

  it("is withheld when nothing is selected", () => {
    expect(inspectorRename(null, hydrateHost())).toBeUndefined();
  });

  it("announces a refusal in the error tone and shows the old label", async () => {
    vi.mocked(setTrackMetaCommand).mockRejectedValue(new Error("nope"));
    const rename = inspectorRename(track, hydrateHost());
    rename?.("Narrator");
    await vi.waitFor(() =>
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        message: "Could not rename the track: nope",
        tone: "error",
      }),
    );
    expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Host");
  });
});
