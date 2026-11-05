import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { makeRangeTarget } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import { setChrome } from "../test/chrome";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  startExportJob: vi.fn(),
}));

describe("export.deliverables", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.startExportJob).mockReset();
    setChrome({ exportRequested: false, bounceRequested: false });
    useDawStore.setState({
      projectPath: "/tmp/test/episode.sharecut",
      project: minimalProject(),
      guestMode: null,
      stage: "edit",
    });
  });

  it("goes to Deliver and asks for the export instead of starting a render", async () => {
    expect(
      await execute("export.deliverables", {}, { skipWhen: true }),
    ).toEqual({ status: "ok" });
    expect(useDawStore.getState().chrome.exportRequested).toBe(true);
    expect(useDawStore.getState().stage).toBe("deliver");
    expect(api.startExportJob).not.toHaveBeenCalled();
  });

  it("asks for nothing without a loaded host project", async () => {
    useDawStore.setState({ project: null, stage: "edit" });
    expect(
      await execute("export.deliverables", {}, { skipWhen: true }),
    ).toEqual({ status: "disabled", reason: "No project loaded" });
    expect(useDawStore.getState().chrome.exportRequested).toBe(false);
    expect(useDawStore.getState().stage).toBe("edit");
  });

  describe("with a range selected", () => {
    const rangedProject = minimalProject({
      render_status: {
        needs_rerender: false,
        reconciliation: { stale: false },
        premix: { exists: true },
      },
      tracks: [sampleTrack({ id: "a", range_media_seal: "a" })],
      clips: {
        tracks: {
          a: [
            clipRow({
              id: "c",
              track_id: "a",
              source_id: null,
              source_start: 0,
              source_end: 5,
              timeline_start: 10,
              timeline_end: 15,
            }),
          ],
        },
        clip_count: 1,
      },
    });
    const target = makeRangeTarget(
      rangedProject,
      [{ start: 11, end: 12 }],
      ["a"],
    )!;

    it("opens Deliver with Bounce focused on the range instead of asking for the export", async () => {
      useDawStore.setState({
        project: rangedProject,
        selection: { kind: "range", target },
        bounceRangeTarget: null,
      });
      expect(
        await execute("export.deliverables", {}, { skipWhen: true }),
      ).toEqual({ status: "ok" });
      const s = useDawStore.getState();
      expect(s.stage).toBe("deliver");
      expect(s.bounceRangeTarget).toEqual(target);
      expect(s.chrome.bounceRequested).toBe(true);
      expect(s.chrome.exportRequested).toBe(false);
    });

    it("exports when Deliver is already the stage, even with a stale range", async () => {
      useDawStore.setState({
        project: rangedProject,
        stage: "deliver",
        selection: { kind: "range", target },
        bounceRangeTarget: null,
      });
      expect(
        await execute("export.deliverables", {}, { skipWhen: true }),
      ).toEqual({ status: "ok" });
      const s = useDawStore.getState();
      expect(s.bounceRangeTarget).toBeNull();
      expect(s.chrome.bounceRequested).toBe(false);
      expect(s.chrome.exportRequested).toBe(true);
    });

    it("refuses with the resolver's reason when a transcript range has no target", async () => {
      useDawStore.setState({
        project: rangedProject,
        selection: {
          kind: "transcriptRange",
          startWordIndex: 0,
          endWordIndex: 0,
        } as never,
        bounceRangeTarget: null,
      });
      const result = await execute(
        "export.deliverables",
        {},
        { skipWhen: true },
      );
      expect(result.status).toBe("disabled");
      const s = useDawStore.getState();
      expect(s.chrome.exportRequested).toBe(false);
      expect(s.chrome.bounceRequested).toBe(false);
      expect(s.stage).toBe("edit");
    });

    it("exports as before when the selection is not a range", async () => {
      useDawStore.setState({
        project: rangedProject,
        selection: { kind: "clip", trackId: "a", clipId: "c" } as never,
        bounceRangeTarget: null,
      });
      await execute("export.deliverables", {}, { skipWhen: true });
      const s = useDawStore.getState();
      expect(s.bounceRangeTarget).toBeNull();
      expect(s.chrome.exportRequested).toBe(true);
    });
  });
});
