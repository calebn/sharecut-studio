import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executePointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { HISTORY_ROOT_ID } from "../types/project";
import { ApiError } from "../utils/apiError";
import { clientXToTimelineSec } from "../utils/timelinePointer";
import { useSplitAtPointer } from "./useSplitAtPointer";

vi.mock("../commands/pointer", () => ({ executePointerCommand: vi.fn() }));
vi.mock("../commands/seek", () => ({ seekTransport: vi.fn() }));
vi.mock("../utils/timelinePointer", () => ({
  clientXToTimelineSec: vi.fn(() => 4),
}));

function TestLanes() {
  const lanesRef = useRef<HTMLDivElement>(null);
  const split = useSplitAtPointer(lanesRef, 10, 20);
  return (
    <div
      ref={lanesRef}
      data-testid="lanes"
      onPointerDownCapture={split.onPointerDownCapture}
      onClickCapture={split.onClickCapture}
    />
  );
}

function altClick() {
  const lanes = screen.getByTestId("lanes");
  fireEvent.pointerDown(lanes, { altKey: true, clientX: 40, clientY: 10 });
  fireEvent.click(lanes, { altKey: true, clientX: 40, clientY: 10 });
}

describe("useSplitAtPointer refusal ownership", () => {
  beforeEach(() => {
    useDawStore.setState({
      project: minimalProject(),
      projectPath: "/tmp/episode",
      guestMode: null,
      shareCapabilities: null,
      scrollLeft: 0,
      statusAnnouncement: "",
      feedbackToast: null,
    });
    vi.clearAllMocks();
    vi.mocked(executePointerCommand).mockResolvedValue({ status: "ok" });
  });

  it("keeps a handler-owned refusal announcement through Alt-click", async () => {
    const result = {
      status: "disabled",
      reason: "generic refusal",
      told: true,
    } as const;
    vi.mocked(executePointerCommand).mockImplementationOnce(async () => {
      useDawStore
        .getState()
        .announceStatus("Split failed: project changed", { tone: "error" });
      return result;
    });
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    render(<TestLanes />);
    altClick();
    await waitFor(() => expect(executePointerCommand).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Split failed: project changed",
      ),
    );
    expect(announce).toHaveBeenCalledExactlyOnceWith(
      "Split failed: project changed",
      { tone: "error" },
    );
    expect(clientXToTimelineSec).toHaveBeenCalled();
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Split failed: project changed",
    });
  });

  it("does not overwrite a standing Undo toast for an intentionally quiet refusal", async () => {
    vi.mocked(executePointerCommand).mockResolvedValueOnce({
      status: "disabled",
      reason: "Project changed during refresh",
      told: true,
    });
    useDawStore
      .getState()
      .announceStatus("Saved edit", { undo: HISTORY_ROOT_ID });
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    announce.mockClear();
    render(<TestLanes />);
    altClick();

    await waitFor(() => expect(executePointerCommand).toHaveBeenCalledOnce());

    expect(announce).not.toHaveBeenCalled();
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      undo: HISTORY_ROOT_ID,
    });
  });

  it("announces an untold refusal as an error", async () => {
    vi.mocked(executePointerCommand).mockResolvedValueOnce({
      status: "disabled",
      reason: "generic refusal",
    });
    render(<TestLanes />);
    altClick();

    await waitFor(() => expect(executePointerCommand).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe("generic refusal"),
    );

    expect(useDawStore.getState().feedbackToast).toMatchObject({
      tone: "error",
    });
  });

  it("keeps the split-specific wording for rejected commands", async () => {
    vi.mocked(executePointerCommand).mockRejectedValueOnce(
      new ApiError("No clip", "no_clip_at_time", 409),
    );
    render(<TestLanes />);
    altClick();

    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "There is no clip at that time to split",
      ),
    );
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      tone: "error",
    });
  });
});

describe("useSplitAtPointer window listeners", () => {
  beforeEach(() => {
    useDawStore.setState({
      project: minimalProject(),
      projectPath: "/tmp/episode",
      guestMode: null,
      shareCapabilities: null,
      scrollLeft: 0,
    });
    vi.clearAllMocks();
  });

  function ZoomLanes({ zoom }: { zoom: number }) {
    const lanesRef = useRef<HTMLDivElement>(null);
    const split = useSplitAtPointer(lanesRef, zoom, 20);
    return (
      <div
        ref={lanesRef}
        data-testid="lanes"
        onPointerMove={split.onPointerMove}
      />
    );
  }

  it("runs the latest committed show when Alt is pressed after a rerender", () => {
    const { rerender } = render(<ZoomLanes zoom={10} />);
    // Pointer rests inside without Alt, so nothing is shown yet.
    fireEvent.pointerMove(screen.getByTestId("lanes"), { clientX: 40 });
    expect(clientXToTimelineSec).not.toHaveBeenCalled();
    rerender(<ZoomLanes zoom={20} />);
    expect(clientXToTimelineSec).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Alt" });

    expect(clientXToTimelineSec).toHaveBeenCalledOnce();
    expect(vi.mocked(clientXToTimelineSec).mock.calls[0]?.[3]).toBe(20);
    expect(useDawStore.getState().splitHoverSec).toBe(4);
  });
});
