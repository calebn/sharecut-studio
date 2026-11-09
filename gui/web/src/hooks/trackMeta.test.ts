import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTrackMetaCommand } from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { sendTrackMeta } from "./trackMeta";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  setTrackMetaCommand: vi.fn(),
}));
vi.mock("../document/applyDocumentUpdate", async (original) => ({
  ...(await original<typeof import("../document/applyDocumentUpdate")>()),
  redisplayDrafts: vi.fn(),
}));

const PATH = "/tmp/ep.json";

function labelOf(): string | undefined {
  return useDawStore.getState().project?.tracks[0]?.label;
}

function showLabel(label: string) {
  const project = useDawStore.getState().project;
  if (!project) return;
  useDawStore.getState().setProject({
    ...project,
    tracks: project.tracks.map((t) => ({ ...t, label })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useDawStore
    .getState()
    .hydrate(
      PATH,
      minimalProject({ tracks: [sampleTrack({ id: "host", label: "Host" })] }),
    );
});

describe("sendTrackMeta", () => {
  it("sends the fields for the track and shows the new label while the host answers", async () => {
    let answer: (value: Record<string, unknown>) => void = () => {};
    vi.mocked(setTrackMetaCommand).mockImplementation(
      (_path, _id, fields) =>
        new Promise((resolve) => {
          showLabel(fields.label ?? "");
          answer = resolve;
        }),
    );
    const sending = sendTrackMeta("host", { label: "Guest" });
    expect(labelOf()).toBe("Guest");
    expect(setTrackMetaCommand).toHaveBeenCalledWith(PATH, "host", {
      label: "Guest",
    });
    answer({});
    await sending;
    expect(labelOf()).toBe("Guest");
  });

  it("puts the old label back and rethrows when the host refuses", async () => {
    vi.mocked(setTrackMetaCommand).mockImplementation(async (_p, _id, f) => {
      showLabel(f.label ?? "");
      throw new Error("nope");
    });
    await expect(sendTrackMeta("host", { label: "Guest" })).rejects.toThrow(
      "nope",
    );
    expect(labelOf()).toBe("Host");
  });

  it("announces a queued send", async () => {
    vi.mocked(setTrackMetaCommand).mockResolvedValue({ queued: true });
    await sendTrackMeta("host", { speaker: "Mira" });
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      "Track metadata change queued. Still sending.",
    );
  });
});
