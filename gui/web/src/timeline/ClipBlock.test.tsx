import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rollClipJoin, setClipFade, trimClipEdge } from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawKeymapListener } from "../keymap/listener";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { place, press } from "../test/hitDom";
import type { ClipRow, ProjectView } from "../types/project";
import { ClipBlock } from "./ClipBlock";
import { ClipBlockView } from "./ClipBlockView";
import { clipBlockGeometry } from "./clipBlockGeometry";
import { attachHitRouting } from "./hitRouting";

type LayerProps = {
  mediaRef: string;
  kind: string;
  mediaStartSec: number;
  clipLeftCss: number;
  clipWidthCss: number;
  zoom: number;
  colorVar: string;
  role: string;
  gainDb: number;
};

const layers = vi.hoisted(() => [] as LayerProps[][]);

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  rollClipJoin: vi.fn(async () => undefined),
  trimClipEdge: vi.fn(async () => ({ queued: false, asked: false })),
  setClipFade: vi.fn(async () => undefined),
  loadWaveformSnap: vi.fn(async () => ({ ticks: [0.5] })),
}));

const { loadBoundaryContext } = vi.hoisted(() => ({
  loadBoundaryContext: vi.fn(),
}));
vi.mock("../api/boundary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/boundary")>()),
  loadBoundaryContext,
}));

// The layer is tested in WaveformLayer.test.tsx; here, what the clip gives it.
vi.mock("./WaveformLayer", () => ({
  WaveformLayer: (p: LayerProps) => {
    layers.at(-1)?.push(p);
    return <div className="clip-waveform" data-media-ref={p.mediaRef} />;
  },
}));

const clip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 2,
  timeline_start: 0,
  timeline_end: 2,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
  recording_key: null,
  source_duration_sec: 10,
};

function KeymapHarness() {
  useDawKeymapListener();
  return null;
}

function projectWithClip(row: ClipRow, overrides: Partial<ProjectView> = {}) {
  return minimalProject({
    tracks: [sampleTrack({ id: "host", duration_sec: 10 })],
    clips: { tracks: { host: [row] }, clip_count: 1 },
    ...overrides,
  });
}

describe("ClipBlock waveform", () => {
  beforeEach(() => {
    useDawStore.setState({ project: null, projectPath: "" });
    layers.push([]);
    loadBoundaryContext.mockResolvedValue({ token: "boundary-token" });
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  const base = {
    clip,
    trackId: "host",
    role: "dialogue",
    zoomPxPerSec: 50,
    color: "var(--clip-dialogue-0)",
    selected: false,
    mediaRef: "track:host",
    prevClip: null,
    nextClip: null,
    neighborSourceLo: 0,
    neighborSourceHi: 10,
    leftNeighborSourceEnd: 0,
    mediaDurationSec: 10,
    rollPreview: null,
    onRollPreview: vi.fn(),
    onSelect: vi.fn(),
    onHit: vi.fn(),
    onSelectClip: vi.fn(),
    onMovePreview: vi.fn(),
    onMoveCommit: vi.fn(),
    onMoveCancel: vi.fn(),
  } as const;

  const renderWithKeymap = (
    row: ClipRow,
    extra: Record<string, unknown> = {},
    project: ProjectView = projectWithClip(row),
  ) => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/clip-handle.project.json", project);
    return render(
      <>
        <KeymapHarness />
        <ClipBlock {...base} {...extra} clip={row} />
      </>,
    );
  };

  describe("focused edge keyboard edits", () => {
    beforeEach(() => {
      vi.mocked(setClipFade).mockClear();
      vi.mocked(trimClipEdge).mockClear();
      loadBoundaryContext.mockClear();
    });

    it.each([
      ["fade in right", "fade-corner in", "ArrowRight", 110, 200],
      ["fade in left", "fade-corner in", "ArrowLeft", 90, 200],
      ["fade out left", "fade-corner out", "ArrowLeft", 100, 210],
      ["fade out right", "fade-corner out", "ArrowRight", 100, 190],
    ])(
      "moves only the requested fade edge with Shift: %s",
      async (_name, selector, key, inMs, outMs) => {
        const row = { ...clip, fade_in_ms: 100, fade_out_ms: 200 };
        const { container } = renderWithKeymap(row);
        const handle = container.querySelector(
          `button.${selector.replaceAll(" ", ".")}`,
        ) as HTMLElement;
        handle.focus();
        fireEvent.keyDown(handle, { key, shiftKey: true });
        const changedEdge = selector.endsWith("in") ? "in" : "out";
        expect(
          container.querySelector(`.fade-readout.${changedEdge}`)?.textContent,
        ).toBe(`${changedEdge === "in" ? inMs : outMs} ms`);
        fireEvent.keyUp(handle, { key });
        await waitFor(() => expect(setClipFade).toHaveBeenCalledOnce());
        expect(setClipFade).toHaveBeenCalledWith(
          "/tmp/clip-handle.project.json",
          "c1",
          inMs,
          outMs,
        );
      },
    );

    it.each([
      ["trim in right", "trim-handle in", "ArrowRight", 1.1],
      ["trim in left", "trim-handle in", "ArrowLeft", 0.9],
      ["trim out right", "trim-handle out", "ArrowRight", 3.1],
      ["trim out left", "trim-handle out", "ArrowLeft", 2.9],
    ])(
      "moves only the requested trim edge with Shift: %s",
      async (_name, selector, key, value) => {
        const row = {
          ...clip,
          source_start: 1,
          source_end: 3,
          timeline_start: 1,
          timeline_end: 3,
        };
        const { container } = renderWithKeymap(row);
        const handle = container.querySelector(
          `button.${selector.replaceAll(" ", ".")}`,
        ) as HTMLElement;
        handle.focus();
        fireEvent.keyDown(handle, { key, shiftKey: true });
        fireEvent.keyUp(handle, { key });
        await waitFor(() => expect(trimClipEdge).toHaveBeenCalledOnce());
        expect(trimClipEdge).toHaveBeenCalledWith(
          "/tmp/clip-handle.project.json",
          "c1",
          selector.endsWith("in") ? "in" : "out",
          value,
          "ripple",
          "boundary-token",
        );
      },
    );

    it("coalesces repeated fade arrows into one write at key release", async () => {
      const row = { ...clip, fade_in_ms: 20, fade_out_ms: 40 };
      const { container } = renderWithKeymap(row);
      const handle = container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
      fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
      expect(container.querySelector(".fade-readout.in")?.textContent).toBe(
        "23 ms",
      );
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await waitFor(() => expect(setClipFade).toHaveBeenCalledOnce());
      expect(setClipFade).toHaveBeenCalledWith(
        "/tmp/clip-handle.project.json",
        "c1",
        23,
        40,
      );
    });

    it("stops a held arrow at a soft boundary with a bump and a note (#1115)", async () => {
      const { container } = renderWithKeymap(clip);
      useDawStore.setState({ playheadSec: 2.025 });
      const handle = container.querySelector(
        "button.trim-handle.out",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      for (let i = 0; i < 4; i += 1) {
        fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
      }
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Trim end stopped at the playhead",
      );
      expect(handle).toHaveAttribute("data-bump");
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await waitFor(() => expect(trimClipEdge).toHaveBeenCalledOnce());
      expect(vi.mocked(trimClipEdge).mock.calls[0]?.[3]).toBeCloseTo(2.025, 6);
      expect(handle).not.toHaveAttribute("data-bump");
    });

    it("commits the active preview on blur and cancels it on Escape", async () => {
      const { container, rerender } = renderWithKeymap({
        ...clip,
        fade_in_ms: 10,
      });
      let handle = container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      handle.blur();
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          11,
          0,
        ),
      );

      vi.mocked(setClipFade).mockClear();
      clearRegisteredCommands();
      registerDawCommands();
      const row = { ...clip, fade_in_ms: 10 };
      useDawStore
        .getState()
        .hydrate("/tmp/clip-handle.project.json", projectWithClip(row));
      rerender(
        <>
          <KeymapHarness />
          <ClipBlock {...base} clip={row} />
        </>,
      );
      handle = container.querySelector("button.fade-corner.in") as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyDown(handle, { key: "Escape" });
      expect(container.querySelector(".fade-readout")).toBeNull();
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(setClipFade).not.toHaveBeenCalled();
    });

    it("does not save a trim nudge that returns to its original boundary", async () => {
      const row = {
        ...clip,
        source_start: 1.005,
        source_end: 3,
        timeline_start: 1.005,
        timeline_end: 3,
      };
      const { container } = renderWithKeymap(row);
      const handle = container.querySelector(
        "button.trim-handle.in",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(trimClipEdge).not.toHaveBeenCalled();
    });

    it("clamps fade and trim keyboard previews to their live bounds", async () => {
      const fadeRow = { ...clip, fade_in_ms: 1998 };
      const fadeView = renderWithKeymap(fadeRow);
      const fadeHandle = fadeView.container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      fadeHandle.focus();
      fireEvent.keyDown(fadeHandle, { key: "ArrowRight", repeat: true });
      fireEvent.keyDown(fadeHandle, { key: "ArrowRight", repeat: true });
      expect(
        fadeView.container.querySelector(".fade-readout.in")?.textContent,
      ).toBe("2000 ms");
      fireEvent.keyUp(fadeHandle, { key: "ArrowRight" });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          2000,
          0,
        ),
      );

      fadeView.unmount();
      vi.mocked(setClipFade).mockClear();
      const trimRow = {
        ...clip,
        source_start: 1,
        source_end: 3.95,
        timeline_start: 1,
        timeline_end: 3.95,
      };
      const neighbor = {
        ...clip,
        id: "c2",
        source_start: 4,
        source_end: 5,
        timeline_start: 4,
        timeline_end: 5,
      };
      const trimView = renderWithKeymap(
        trimRow,
        { neighborSourceHi: 4, nextClip: neighbor },
        minimalProject({
          tracks: [sampleTrack({ id: "host", duration_sec: 10 })],
          clips: { tracks: { host: [trimRow, neighbor] }, clip_count: 2 },
        }),
      );
      const trimHandle = trimView.container.querySelector(
        "button.trim-handle.out",
      ) as HTMLElement;
      trimHandle.focus();
      fireEvent.keyDown(trimHandle, {
        key: "ArrowRight",
        shiftKey: true,
        repeat: true,
      });
      expect(
        trimView.container.querySelector(".clip-trim-ghost"),
      ).not.toBeNull();
      fireEvent.keyUp(trimHandle, { key: "ArrowRight" });
      await waitFor(() =>
        expect(trimClipEdge).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          "out",
          4,
          "ripple",
          "boundary-token",
        ),
      );
    });

    it("uses the destination lane bounds when a clip retains its origin track", async () => {
      const row = {
        ...clip,
        track_id: "guest",
        origin_track_id: "host",
      };
      const next = {
        ...clip,
        id: "c2",
        track_id: "guest",
        source_start: 5,
        source_end: 7,
        timeline_start: 5,
        timeline_end: 7,
      };
      const project = minimalProject({
        tracks: [
          sampleTrack({ id: "host", duration_sec: 10, fade_max_ms: 100 }),
          sampleTrack({ id: "guest", duration_sec: 10, fade_max_ms: 40 }),
        ],
        clips: { tracks: { host: [], guest: [row, next] }, clip_count: 2 },
      });
      const { container } = renderWithKeymap(
        row,
        {
          trackId: "host",
          fadeMaxMs: 40,
          neighborSourceHi: 5,
          nextClip: next,
        },
        project,
      );
      const handle = container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyUp(handle, { key: "ArrowRight" });

      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          "/tmp/clip-handle.project.json",
          "c1",
          1,
          0,
        ),
      );
    });

    it("cancels a keyboard preview when the project epoch changes", async () => {
      const row = { ...clip, fade_in_ms: 10 };
      const { container } = renderWithKeymap(row);
      const handle = container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(container.querySelector(".fade-readout.in")).not.toBeNull();
      useDawStore.setState((state) => ({
        projectEpoch: state.projectEpoch + 1,
      }));
      await waitFor(() =>
        expect(container.querySelector(".fade-readout")).toBeNull(),
      );
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(setClipFade).not.toHaveBeenCalled();
    });

    it("restores keyboard ownership when a same-path epoch changes under the focused handle", async () => {
      const row = { ...clip, fade_in_ms: 20 };
      const view = renderWithKeymap(row);
      const handle = view.container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.focus();
      useDawStore.setState((state) => ({
        projectEpoch: state.projectEpoch + 1,
      }));
      view.rerender(
        <>
          <KeymapHarness />
          <ClipBlock {...base} clip={row} />
        </>,
      );
      expect(document.activeElement).toBe(handle);

      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(
        view.container.querySelector(".fade-readout.in")?.textContent,
      ).toBe("21 ms");
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          "/tmp/clip-handle.project.json",
          "c1",
          21,
          0,
        ),
      );
      expect(useDawStore.getState().playheadSec).toBe(0);
    });

    it("routes arrows to the playhead when the focused fade handle is removed", async () => {
      const previous = { ...clip, id: "previous", source_end: 2 };
      const row = {
        ...clip,
        fade_in_ms: 20,
        join_left_clip_id: "previous",
        join_in_mode: "fade",
      };
      const view = renderWithKeymap(row, { prevClip: previous });
      const handle = view.container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.focus();
      expect(document.activeElement).toBe(handle);
      view.rerender(
        <>
          <KeymapHarness />
          <ClipBlock
            {...base}
            clip={{ ...row, join_in_mode: "cut" }}
            prevClip={previous}
          />
        </>,
      );
      expect(view.container.querySelector("button.fade-corner.in")).toBeNull();

      useDawStore.getState().setPlayheadSec(1);
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      fireEvent.keyUp(document.body, { key: "ArrowRight" });
      await waitFor(() => expect(useDawStore.getState().playheadSec).toBe(2));
      expect(setClipFade).not.toHaveBeenCalled();
    });

    it("keeps the clip mutation lock through a pending fade write", async () => {
      let resolveFade!: () => void;
      vi.mocked(setClipFade).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFade = resolve;
          }),
      );
      const { container } = renderWithKeymap({ ...clip, fade_in_ms: 10 });
      const fadeHandle = container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      fadeHandle.focus();
      fireEvent.keyDown(fadeHandle, { key: "ArrowRight" });
      fireEvent.keyUp(fadeHandle, { key: "ArrowRight" });
      await waitFor(() => expect(setClipFade).toHaveBeenCalledOnce());

      const trimHandle = container.querySelector(
        "button.trim-handle.in",
      ) as HTMLElement;
      trimHandle.focus();
      fireEvent.keyDown(trimHandle, { key: "ArrowRight" });
      fireEvent.keyUp(trimHandle, { key: "ArrowRight" });
      expect(trimClipEdge).not.toHaveBeenCalled();
      resolveFade();
      await waitFor(() =>
        expect(container.querySelector(".fade-readout")).toBeNull(),
      );
    });

    it("does not let an old project write clear a new same-clip draft", async () => {
      let resolveOldWrite!: () => void;
      vi.mocked(setClipFade).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldWrite = resolve;
          }),
      );
      const firstRow = { ...clip, fade_in_ms: 10 };
      const view = renderWithKeymap(firstRow);
      let handle = view.container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await waitFor(() => expect(setClipFade).toHaveBeenCalledOnce());

      const secondRow = { ...clip, fade_in_ms: 40 };
      const secondPath = "/tmp/next-clip-handle.project.json";
      useDawStore.getState().hydrate(secondPath, projectWithClip(secondRow));
      view.rerender(
        <>
          <KeymapHarness />
          <ClipBlock {...base} clip={secondRow} />
        </>,
      );
      handle = view.container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.blur();
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(
        view.container.querySelector(".fade-readout.in")?.textContent,
      ).toBe("41 ms");

      resolveOldWrite();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        view.container.querySelector(".fade-readout.in")?.textContent,
      ).toBe("41 ms");
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await waitFor(() => expect(setClipFade).toHaveBeenCalledTimes(2));
      expect(setClipFade).toHaveBeenLastCalledWith(secondPath, "c1", 41, 0);
    });

    it("says Trim saved for a trim the host applies, and nothing when it asks first", async () => {
      const row = { ...clip, source_end: 2, timeline_end: 2 };
      const { container } = renderWithKeymap(row);
      const handle = container.querySelector(
        "button.trim-handle.out",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      fireEvent.keyUp(handle, { key: "ArrowLeft" });
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe("Trim saved"),
      );

      useDawStore.getState().announceStatus("");
      vi.mocked(trimClipEdge).mockResolvedValueOnce({
        queued: false,
        asked: true,
      });
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(container.querySelector(".trim-readout")).not.toBeNull();
      fireEvent.keyUp(handle, { key: "ArrowLeft" });
      await waitFor(() => expect(trimClipEdge).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(container.querySelector(".trim-readout")).toBeNull(),
      );
      expect(useDawStore.getState().statusAnnouncement).toBe("");
    });

    it("announces a failed keyboard write and clears its preview", async () => {
      vi.mocked(setClipFade).mockRejectedValueOnce(new Error("write failed"));
      const { container } = renderWithKeymap({ ...clip, fade_in_ms: 10 });
      const handle = container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      handle.focus();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyUp(handle, { key: "ArrowRight" });
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Clip edit failed: write failed",
        ),
      );
      expect(container.querySelector(".fade-readout")).toBeNull();
    });
  });

  it("draws its media from the clip's left edge in timeline px", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          source_start: 3,
          source_end: 5,
          timeline_start: 1,
          timeline_end: 3,
        }}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(container.querySelector(".clip-waveform")).toBeTruthy();
    expect(layers.at(-1)!.at(-1)).toEqual({
      mediaRef: "track:host",
      kind: "raw",
      mediaStartSec: 3,
      clipLeftCss: 50,
      clipWidthCss: 100,
      zoom: 50,
      colorVar: "var(--clip-dialogue-0)",
      role: "dialogue",
      gainDb: 0,
    });
  });

  it("puts stem media on the timeline clock", () => {
    render(
      <ClipBlock
        {...base}
        mediaRef="stem:host"
        clip={{
          ...clip,
          source_start: 3,
          source_end: 5,
          timeline_start: 1,
          timeline_end: 3,
        }}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(layers.at(-1)!.at(-1)).toMatchObject({
      mediaRef: "stem:host",
      kind: "stem",
      mediaStartSec: 1,
    });
  });

  it("passes the track output gain to the waveform layer", () => {
    render(<ClipBlock {...base} gainDb={-4} />);
    expect(layers.at(-1)!.at(-1)).toMatchObject({
      role: "dialogue",
      gainDb: -4,
    });
  });

  it("defaults the waveform layer gain to 0 dB", () => {
    render(<ClipBlock {...base} />);
    expect(layers.at(-1)!.at(-1)).toMatchObject({ gainDb: 0 });
  });

  it("puts one top-corner fade handle on each edge, marked .zero at 0 ms", () => {
    const { container, rerender } = render(<ClipBlock {...base} />);
    const zeroIn = container.querySelector(
      "button.fade-corner.in.zero",
    ) as HTMLElement;
    expect(zeroIn).toBeTruthy();
    expect(zeroIn.style.left).toBe("0px");
    const zeroOut = container.querySelector(
      "button.fade-corner.out.zero",
    ) as HTMLElement;
    expect(zeroOut).toBeTruthy();
    expect(zeroOut.style.right).toBe("0px");
    rerender(<ClipBlock {...base} clip={{ ...clip, fade_in_ms: 40 }} />);
    const cornerIn = container.querySelector(
      "button.fade-corner.in",
    ) as HTMLElement;
    expect(cornerIn.classList.contains("zero")).toBe(false);
    expect(cornerIn.style.left).toBe("2px");
    expect(container.querySelector(".clip-fade-line")?.getAttribute("d")).toBe(
      "M0 100L2 0",
    );
  });

  it("hides only the fades at a cut join and keeps trim and roll", () => {
    const faded = { ...clip, fade_in_ms: 20, fade_out_ms: 20 };
    const prev = { ...clip, id: "c0" };
    const { container, rerender } = render(
      <ClipBlock {...base} clip={faded} prevClip={prev} />,
    );
    expect(container.querySelectorAll(".clip-fade-line")).toHaveLength(2);
    // Incoming join is a cut: the fade-in goes, the fade-out stays.
    rerender(
      <ClipBlock
        {...base}
        clip={{ ...faded, join_in_mode: "cut", join_left_clip_id: "c0" }}
        prevClip={prev}
      />,
    );
    expect(container.querySelectorAll(".clip-fade-line")).toHaveLength(1);
    expect(container.querySelector(".clip-fade-line")?.getAttribute("d")).toBe(
      "M99 0L100 100",
    );
    expect(container.querySelector("button.fade-corner.in")).toBeNull();
    expect(container.querySelector("button.fade-corner.out")).not.toBeNull();
    expect(container.querySelectorAll(".trim-handle")).toHaveLength(2);
    expect(container.querySelector("button.join-seam")).not.toBeNull();
    // Outgoing join is a cut: the fade-out goes, the fade-in stays.
    rerender(
      <ClipBlock
        {...base}
        clip={faded}
        prevClip={prev}
        nextClip={{
          ...clip,
          id: "c2",
          join_in_mode: "cut",
          join_left_clip_id: "c1",
        }}
      />,
    );
    expect(container.querySelectorAll(".clip-fade-line")).toHaveLength(1);
    expect(container.querySelector(".clip-fade-line")?.getAttribute("d")).toBe(
      "M0 100L1 0",
    );
    expect(container.querySelector("button.fade-corner.out")).toBeNull();
    expect(container.querySelector("button.fade-corner.in")).not.toBeNull();
    expect(container.querySelectorAll(".trim-handle")).toHaveLength(2);
  });

  it("keeps a first clip's fade-in when its leftover mode is cut", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          fade_in_ms: 20,
          join_in_mode: "cut",
          join_left_clip_id: null,
        }}
        prevClip={null}
      />,
    );
    expect(container.querySelector(".clip-fade-line")).not.toBeNull();
  });

  describe("fade handle drags", () => {
    const dragIn = (
      dxPx: number,
      props: { fadeMaxMs?: number | null; clip?: ClipRow } = {},
    ) => {
      const view = render(<ClipBlock {...base} {...props} />);
      const handle = view.container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 100 + dxPx, pointerId: 3 });
      return { ...view, handle };
    };

    beforeEach(() => {
      vi.mocked(setClipFade).mockClear();
    });

    it("clamps to the track cap, shows it live and commits it", async () => {
      const { container, handle } = dragIn(25, { fadeMaxMs: 40 });
      expect(handle.isConnected).toBe(true);
      expect(container.querySelector(".fade-readout.in")?.textContent).toBe(
        "40 ms",
      );
      expect(
        (container.querySelector(".fade-readout.in") as HTMLElement).style.left,
      ).toBe("2px");
      expect(handle.style.left).toBe("2px");
      expect(handle.classList.contains("zero")).toBe(true);
      fireEvent.pointerUp(handle, { clientX: 125, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          40,
          0,
        ),
      );
      expect(container.querySelector(".fade-readout")).toBeNull();
      expect(container.querySelector(".clip-block.fade-dragging")).toBeNull();
    });

    it("clamps an uncapped track to the clip length", async () => {
      const { handle } = dragIn(250);
      fireEvent.pointerUp(handle, { clientX: 350, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          2000,
          0,
        ),
      );
    });

    it("never saves a click under the drag threshold", async () => {
      const { container, handle } = dragIn(1);
      fireEvent.pointerUp(handle, { clientX: 101, pointerId: 3 });
      await new Promise((r) => setTimeout(r, 0));
      expect(setClipFade).not.toHaveBeenCalled();
      expect(container.querySelector(".fade-readout")).toBeNull();
    });

    it("drags a committed fade to zero from its region handle", async () => {
      const { container } = render(
        <ClipBlock {...base} clip={{ ...clip, fade_in_ms: 40 }} />,
      );
      const handle = container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 0, pointerId: 3 });
      expect(handle.isConnected).toBe(true);
      expect(container.querySelector(".fade-readout.in")?.textContent).toBe(
        "0 ms",
      );
      fireEvent.pointerUp(handle, { clientX: 0, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(expect.anything(), "c1", 0, 0),
      );
      expect(container.querySelector(".fade-readout")).toBeNull();
    });

    it("keeps the two fades from overlapping", async () => {
      const { container, handle } = dragIn(100, {
        clip: { ...clip, fade_out_ms: 1500 },
      });
      expect(container.querySelector(".fade-readout.in")?.textContent).toBe(
        "500 ms",
      );
      fireEvent.pointerUp(handle, { clientX: 200, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          500,
          1500,
        ),
      );
    });

    it("writes nothing when a drag leaves the fade at the cap", async () => {
      const { container } = render(
        <ClipBlock
          {...base}
          fadeMaxMs={40}
          clip={{ ...clip, fade_in_ms: 40 }}
        />,
      );
      const handle = container.querySelector(
        "button.fade-corner.in",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 110, pointerId: 3 });
      fireEvent.pointerUp(handle, { clientX: 110, pointerId: 3 });
      await new Promise((r) => setTimeout(r, 0));
      expect(setClipFade).not.toHaveBeenCalled();
    });

    it("discards a drag that comes back to within 3 px of its start", async () => {
      const { container, handle } = dragIn(25);
      fireEvent.pointerMove(handle, { clientX: 101, pointerId: 3 });
      fireEvent.pointerUp(handle, { clientX: 101, pointerId: 3 });
      await new Promise((r) => setTimeout(r, 0));
      expect(setClipFade).not.toHaveBeenCalled();
      expect(container.querySelector(".fade-readout")).toBeNull();
    });

    it("shows and commits the out-edge readout", async () => {
      const { container } = render(<ClipBlock {...base} fadeMaxMs={40} />);
      const handle = container.querySelector(
        "button.fade-corner.out",
      ) as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(handle, { clientX: 75, pointerId: 3 });
      expect(container.querySelector(".fade-readout.out")?.textContent).toBe(
        "40 ms",
      );
      expect(handle.isConnected).toBe(true);
      fireEvent.pointerUp(handle, { clientX: 75, pointerId: 3 });
      await waitFor(() =>
        expect(setClipFade).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          0,
          40,
        ),
      );
    });

    it("names each fade handle with its length", () => {
      const { container } = render(
        <ClipBlock {...base} clip={{ ...clip, fade_out_ms: 30 }} />,
      );
      const zeroIn = container.querySelector(
        "button.fade-corner.in.zero",
      ) as HTMLElement;
      expect(zeroIn.getAttribute("aria-label")).toContain(" · in 0 ms.");
      const regionOut = container.querySelector(
        "button.fade-corner.out",
      ) as HTMLElement;
      expect(regionOut.getAttribute("aria-label")).toContain(" · out 30 ms.");
    });
  });

  it("draws curves but no fade handles on a ghost or a share project", () => {
    const { container: ghostContainer } = render(
      <ClipBlock
        {...base}
        interactive={false}
        clip={{ ...clip, fade_in_ms: 40 }}
      />,
    );
    expect(ghostContainer.querySelectorAll(".fade-corner")).toHaveLength(0);
    expect(ghostContainer.querySelectorAll(".clip-fade-line")).toHaveLength(1);

    useDawStore.setState({ projectPath: "share:tok" });
    try {
      const { container } = render(
        <ClipBlock {...base} clip={{ ...clip, fade_in_ms: 40 }} />,
      );
      expect(container.querySelectorAll(".fade-corner")).toHaveLength(0);
    } finally {
      useDawStore.setState({ projectPath: "" });
    }
  });

  it.each([".fade-corner.in", ".trim-handle.out", ".join-seam", ".clip-hit"])(
    "keeps %s idle while a coupled join save is in flight",
    async (selector) => {
      vi.mocked(setClipFade).mockClear();
      vi.mocked(trimClipEdge).mockClear();
      vi.mocked(rollClipJoin).mockClear();
      base.onRollPreview.mockClear();
      base.onMovePreview.mockClear();
      base.onMoveCommit.mockClear();
      const { container } = render(
        <ClipBlock
          {...base}
          canMove
          prevClip={{ ...clip, id: "left", source_start: 0, source_end: 1 }}
          clip={{ ...clip, source_start: 1, source_end: 2 }}
        />,
      );
      useDawStore.getState().setJoinMutationInFlight(true);
      try {
        const handle = container.querySelector(selector) as HTMLElement;
        fireEvent.pointerDown(handle, { clientX: 100, pointerId: 5 });
        fireEvent.pointerMove(handle, { clientX: 125, pointerId: 5 });
        fireEvent.pointerUp(handle, { clientX: 125, pointerId: 5 });
        expect(
          container.querySelector(".fade-dragging, .trim-dragging"),
        ).toBeNull();
        expect(base.onRollPreview).not.toHaveBeenCalled();
        expect(base.onMovePreview).not.toHaveBeenCalled();
        expect(base.onMoveCommit).not.toHaveBeenCalled();
        expect(setClipFade).not.toHaveBeenCalled();
        expect(trimClipEdge).not.toHaveBeenCalled();
        expect(rollClipJoin).not.toHaveBeenCalled();
      } finally {
        useDawStore.getState().setJoinMutationInFlight(false);
      }
    },
  );

  describe("trim and roll handle clicks", () => {
    beforeEach(() => {
      vi.mocked(trimClipEdge).mockClear();
      vi.mocked(rollClipJoin).mockClear();
    });

    it("a click on a trim handle only selects", async () => {
      const onSelect = vi.fn();
      const { container } = render(<ClipBlock {...base} onSelect={onSelect} />);
      const h = container.querySelector(".trim-handle.out") as HTMLElement;
      fireEvent.pointerDown(h, { clientX: 100, pointerId: 5 });
      fireEvent.pointerUp(h, { clientX: 101, pointerId: 5 });
      await new Promise((r) => setTimeout(r, 0));
      expect(onSelect).toHaveBeenCalledWith("c1");
      expect(trimClipEdge).not.toHaveBeenCalled();
    });

    it("commits a trim drag", async () => {
      const { container } = render(<ClipBlock {...base} />);
      const h = container.querySelector(".trim-handle.out") as HTMLElement;
      fireEvent.pointerDown(h, { clientX: 100, pointerId: 5 });
      fireEvent.pointerMove(h, { clientX: 150, pointerId: 5 });
      fireEvent.pointerUp(h, { clientX: 150, pointerId: 5 });
      await waitFor(() =>
        expect(trimClipEdge).toHaveBeenCalledWith(
          expect.anything(),
          "c1",
          "out",
          expect.any(Number),
          "ripple",
          "boundary-token",
        ),
      );
    });

    it("preflights a trim with geometry captured at pointer down", async () => {
      const view = render(<ClipBlock {...base} />);
      const handle = view.container.querySelector(
        ".trim-handle.out",
      ) as HTMLElement;
      loadBoundaryContext.mockClear();
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 5 });
      fireEvent.pointerMove(handle, { clientX: 150, pointerId: 5 });
      view.rerender(
        <ClipBlock
          {...base}
          clip={{ ...clip, source_end: 3, timeline_end: 3 }}
        />,
      );
      fireEvent.pointerUp(handle, { clientX: 150, pointerId: 5 });
      expect(loadBoundaryContext).not.toHaveBeenCalled();
      expect(trimClipEdge).not.toHaveBeenCalled();
      expect(view.container.querySelector(".clip-trim-ghost")).toBeNull();
    });

    it("cancels a deferred trim when the loaded project geometry changes before React rerenders", async () => {
      const row = {
        ...clip,
        source_start: 1,
        source_end: 3,
        timeline_start: 1,
        timeline_end: 3,
      };
      clearRegisteredCommands();
      registerDawCommands();
      useDawStore
        .getState()
        .hydrate("/tmp/clip-handle.project.json", projectWithClip(row));
      let resolveBoundary!: (value: { token: string }) => void;
      loadBoundaryContext.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveBoundary = resolve;
        }),
      );
      const { container } = render(<ClipBlock {...base} clip={row} />);
      const handle = container.querySelector(".trim-handle.out") as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 12 });
      fireEvent.pointerMove(handle, { clientX: 150, pointerId: 12 });
      fireEvent.pointerUp(handle, { clientX: 150, pointerId: 12 });
      await waitFor(() => expect(loadBoundaryContext).toHaveBeenCalledOnce());

      useDawStore.setState({
        project: projectWithClip({
          ...row,
          source_end: 3.5,
          timeline_end: 3.5,
        }),
      });
      resolveBoundary({ token: "boundary-token" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(trimClipEdge).not.toHaveBeenCalled();
    });

    it("cancels a deferred trim when its source clip moves to another lane", async () => {
      const row = {
        ...clip,
        source_start: 1,
        source_end: 3,
        timeline_start: 1,
        timeline_end: 3,
      };
      clearRegisteredCommands();
      registerDawCommands();
      useDawStore
        .getState()
        .hydrate("/tmp/clip-handle.project.json", projectWithClip(row));
      let resolveBoundary!: (value: { token: string }) => void;
      loadBoundaryContext.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveBoundary = resolve;
        }),
      );
      const { container } = render(<ClipBlock {...base} clip={row} />);
      const handle = container.querySelector(".trim-handle.out") as HTMLElement;
      fireEvent.pointerDown(handle, { clientX: 100, pointerId: 13 });
      fireEvent.pointerMove(handle, { clientX: 150, pointerId: 13 });
      fireEvent.pointerUp(handle, { clientX: 150, pointerId: 13 });
      await waitFor(() => expect(loadBoundaryContext).toHaveBeenCalledOnce());

      const moved = { ...row, track_id: "guest" };
      useDawStore.setState({
        project: projectWithClip(moved, {
          tracks: [
            sampleTrack({ id: "host", duration_sec: 10 }),
            sampleTrack({ id: "guest", duration_sec: 10 }),
          ],
          clips: { tracks: { host: [], guest: [moved] }, clip_count: 1 },
        }),
      });
      resolveBoundary({ token: "boundary-token" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(trimClipEdge).not.toHaveBeenCalled();
    });

    it("a click on the join seam never rolls", async () => {
      const { container } = render(
        <ClipBlock {...base} prevClip={{ ...clip, id: "c0" }} />,
      );
      const d = container.querySelector("button.join-seam") as HTMLElement;
      fireEvent.pointerDown(d, { clientX: 100, pointerId: 6 });
      fireEvent.pointerUp(d, { clientX: 101, pointerId: 6 });
      await new Promise((r) => setTimeout(r, 0));
      expect(rollClipJoin).not.toHaveBeenCalled();
    });
  });

  it("gives the trim ghost its own layer over the ghost source range", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const handle = container.querySelector(".trim-handle.out");
    expect(handle).toBeTruthy();
    fireEvent.pointerDown(handle as Element, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle as Element, { clientX: 150, pointerId: 1 });
    // The clip sits at x 0; its ghost follows the committed width.
    const rendered = layers.at(-1)!;
    const ghost = rendered.findLast((p) => p.clipLeftCss > 0);
    const main = rendered.findLast((p) => p.clipLeftCss === 0);
    // The ghost follows the committed clip (2 s at 50 px/s) and starts at
    // its source end.
    expect(
      container.querySelector(".clip-trim-ghost .clip-waveform"),
    ).toBeTruthy();
    // The committed clip is 100 px wide; the ghost's border box starts at its
    // edge, 1px left of padding-box x 100.
    expect(
      (container.querySelector(".clip-trim-ghost") as HTMLElement).style.left,
    ).toBe("99px");
    expect(ghost).toMatchObject({
      mediaStartSec: clip.source_end,
      clipLeftCss: 100,
    });
    expect(ghost!.clipWidthCss).toBeGreaterThan(0);
    expect(main!.mediaStartSec).toBe(clip.source_start);
  });

  it("selects on body pointerdown without moving when under the drag threshold", () => {
    const onSelectClip = vi.fn();
    const onMovePreview = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelectClip={onSelectClip}
        onMovePreview={onMovePreview}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 40, clientY: 10, pointerId: 2 });
    fireEvent.pointerMove(hit, { clientX: 42, clientY: 10, pointerId: 2 });
    fireEvent.pointerUp(hit, { clientX: 42, clientY: 10, pointerId: 2 });
    expect(onSelectClip).toHaveBeenCalledWith("c1", {
      shift: false,
      mod: false,
    });
    expect(onMovePreview).not.toHaveBeenCalled();
  });

  it("starts a body move after crossing the pixel threshold", () => {
    const onMovePreview = vi.fn();
    const onMoveCommit = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelectClip={vi.fn()}
        onMovePreview={onMovePreview}
        onMoveCommit={onMoveCommit}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 40, clientY: 10, pointerId: 3 });
    fireEvent.pointerMove(hit, { clientX: 80, clientY: 10, pointerId: 3 });
    expect(onMovePreview).toHaveBeenCalled();
    fireEvent.pointerUp(hit, { clientX: 80, clientY: 10, pointerId: 3 });
    expect(onMoveCommit).toHaveBeenCalled();
    expect(onMoveCommit.mock.calls[0]?.[0]).toBe("c1");
    expect(onMoveCommit.mock.calls[0]?.[1].deltaSec).toBeCloseTo(0.8, 5);
  });

  describe("touch move (#1051 round 4b)", () => {
    /** The clip under the touch grammar's router, its body 100 px wide. */
    const touchClip = (row: ClipRow, extra: Record<string, unknown> = {}) => {
      const view = render(
        <div>
          <ClipBlock {...base} canMove {...extra} clip={row} />
        </div>,
      );
      const root = view.container.firstElementChild as HTMLElement;
      const hit = root.querySelector(".clip-hit") as HTMLElement;
      place(hit, { left: 0, top: 0, right: 100, bottom: 100 });
      const router = attachHitRouting(root);
      root.addEventListener(
        "pointerdown",
        (e) => {
          if (router.defers(e)) e.stopPropagation();
        },
        true,
      );
      return { ...view, hit, router };
    };
    const later = { ...clip, timeline_start: 4, timeline_end: 6 };

    it("arms the body on a long press and moves the clip in time only", () => {
      const onMovePreview = vi.fn();
      const onMoveCommit = vi.fn();
      const { hit, router } = touchClip(later, { onMovePreview, onMoveCommit });
      press(hit, "pointerdown", 50, 50);
      press(hit, "pointermove", 52, 50);
      expect(onMovePreview).not.toHaveBeenCalled();
      router.longPress();
      press(hit, "pointermove", 90, 95);
      press(hit, "pointerup", 90, 95);
      router.dispose();

      expect(onMovePreview).toHaveBeenCalledTimes(1);
      expect(onMovePreview.mock.calls[0][1]).toMatchObject({
        clientX: 90,
        clientY: 50,
      });
      expect(onMoveCommit).toHaveBeenCalledTimes(1);
      expect(onMoveCommit.mock.calls[0][0]).toBe("c1");
      expect(onMoveCommit.mock.calls[0][1].deltaSec).toBeCloseTo(0.8, 5);
    });

    it("bumps at the session start, a clip's hard limit, and says so", () => {
      const { hit, router } = touchClip(clip);
      press(hit, "pointerdown", 50, 50);
      router.longPress();
      act(() => {
        press(hit, "pointermove", 20, 50);
      });
      const atLimit = {
        bump: hit.getAttribute("data-bump"),
        said: useDawStore.getState().statusAnnouncement,
      };
      act(() => {
        press(hit, "pointermove", 80, 50);
      });
      const back = hit.getAttribute("data-bump");
      press(hit, "pointerup", 80, 50);
      router.dispose();

      expect(atLimit).toEqual({ bump: "", said: "Clip is at its limit" });
      expect(back).toBeNull();
    });

    it("drops the move, saving nothing, when a second finger lands", () => {
      const onMoveCommit = vi.fn();
      const onMoveCancel = vi.fn();
      const { hit, router } = touchClip(later, { onMoveCommit, onMoveCancel });
      press(hit, "pointerdown", 50, 50);
      router.longPress();
      press(hit, "pointermove", 90, 50);
      press(hit, "pointerdown", 200, 60, 8);
      press(hit, "pointerup", 90, 50);
      press(hit, "pointerup", 200, 60, 8);
      router.dispose();

      expect(onMoveCancel).toHaveBeenCalledWith("c1");
      expect(onMoveCommit).not.toHaveBeenCalled();
      expect(hit.hasAttribute("data-hit-armed")).toBe(false);
    });
  });

  it("does not body-move in blade mode", () => {
    const onMovePreview = vi.fn();
    const onHit = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        bladeMode
        onMovePreview={onMovePreview}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={onHit}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 40, clientY: 10, pointerId: 4 });
    fireEvent.pointerMove(hit, { clientX: 90, clientY: 10, pointerId: 4 });
    fireEvent.click(hit, { clientX: 90 });
    expect(onMovePreview).not.toHaveBeenCalled();
    expect(onHit).toHaveBeenCalled();
  });

  it("selects from a click when pointerdown never ran", () => {
    const onSelectClip = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelectClip={onSelectClip}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.click(hit, { shiftKey: true });
    expect(onSelectClip).toHaveBeenCalledWith("c1", {
      shift: true,
      mod: false,
    });
    expect(hit.getAttribute("aria-label")).toBe(
      "Select Dialogue clip at 00:00.000, 2s",
    );
  });

  it("leads the clip label and accessible name with its speaker", () => {
    const { container, getByRole } = render(
      <ClipBlock {...base} trackSpeaker="Avery" />,
    );
    expect(container.querySelector(".clip-label")?.textContent).toBe(
      "Avery · 2s",
    );
    expect(
      getByRole("button", { name: "Select Avery clip at 00:00.000, 2s" }),
    ).toBeInTheDocument();
  });

  it("keeps the full clip label on its native button at nonzero timeline time", async () => {
    const timedClip = {
      ...clip,
      id: "internal-clip-id",
      source_start: 30,
      source_end: 36,
      timeline_start: 4,
      timeline_end: 10,
    };
    const { container, getByRole } = render(
      <ClipBlock
        {...base}
        clip={timedClip}
        trackSpeaker="Host"
        zoomPxPerSec={1}
      />,
    );
    const hit = getByRole("button", {
      name: "Select Host clip at 00:04.000, 6s",
    });
    expect(hit).toHaveAttribute("title", "Select Host clip at 00:04.000, 6s");
    expect(container.querySelector(".clip-block")).toHaveAttribute(
      "title",
      "Select Host clip at 00:04.000, 6s",
    );
    expect(container.querySelector(".clip-label")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("labels the full live range during trim and roll previews", () => {
    const { getByRole, rerender } = render(
      <ClipBlockView
        {...base}
        trackSpeaker="Host"
        showHandles
        geometry={clipBlockGeometry({
          clip,
          zoomPxPerSec: 50,
          rollPreview: null,
          trimPreview: {
            edge: "out",
            mode: "ripple",
            sourceStart: 0,
            sourceEnd: 3,
          },
          fadePreview: null,
          previewTimelineStart: null,
        })}
      />,
    );
    expect(
      getByRole("button", { name: "Select Host clip at 00:00.000, 3s" }),
    ).toBeInTheDocument();
    rerender(
      <ClipBlock
        {...base}
        clip={{ ...clip, timeline_start: 2, timeline_end: 4 }}
        trackSpeaker="Host"
        rollPreview={{
          leftClipId: "c0",
          rightClipId: "c1",
          deltaSec: 1,
        }}
      />,
    );
    expect(
      getByRole("button", { name: "Select Host clip at 00:03.000, 1s" }),
    ).toBeInTheDocument();
    rerender(
      <ClipBlock
        {...base}
        trackSpeaker="Host"
        rollPreview={null}
        previewTimelineStart={4}
      />,
    );
    expect(
      getByRole("button", { name: "Select Host clip at 00:04.000, 2s" }),
    ).toBeInTheDocument();
  });

  it("keeps the move hint in a movable clip's tooltip and its accessible name concise", () => {
    const { getByRole } = render(
      <ClipBlock {...base} canMove trackSpeaker="Host" />,
    );
    expect(
      getByRole("button", { name: "Select Host clip at 00:00.000, 2s" }),
    ).toHaveAttribute(
      "title",
      "Select Host clip at 00:00.000, 2s · Drag clip bodies to move in time or onto another track · gaps and overlap allowed",
    );
  });

  it("keeps a long speaker and duration in the accessible name at narrow width", () => {
    const longSpeaker = "Avery Nelson, host and interviewer";
    const longClip = {
      ...clip,
      source_end: 1046,
      timeline_end: 1046,
    };
    const { container, getByRole } = render(
      <ClipBlock
        {...base}
        clip={longClip}
        trackSpeaker={longSpeaker}
        zoomPxPerSec={0.05}
      />,
    );
    expect(container.querySelector(".clip-label")?.textContent).toBe(
      longSpeaker,
    );
    expect(
      getByRole("button", {
        name: `Select ${longSpeaker} clip at 00:00.000, 17m 26s`,
      }),
    ).toBeInTheDocument();
  });

  it.each(["Escape", "blur", "unmount"])(
    "cancels the body owner on %s and ignores later held input",
    (interruption) => {
      const onMovePreview = vi.fn();
      const onMoveCommit = vi.fn();
      const onMoveCancel = vi.fn();
      const view = render(
        <ClipBlock
          {...base}
          canMove
          onSelect={vi.fn()}
          onHit={vi.fn()}
          onSelectClip={vi.fn()}
          onMovePreview={onMovePreview}
          onMoveCommit={onMoveCommit}
          onMoveCancel={onMoveCancel}
        />,
      );
      const hit = view.container.querySelector(".clip-hit") as HTMLElement;
      fireEvent.pointerDown(hit, { pointerId: 7, clientX: 40, clientY: 10 });
      fireEvent.pointerMove(hit, { pointerId: 7, clientX: 80, clientY: 10 });
      expect(onMovePreview).toHaveBeenCalledTimes(1);
      if (interruption === "Escape")
        fireEvent.keyDown(document.body, { key: "Escape" });
      else if (interruption === "blur") fireEvent.blur(hit);
      else view.unmount();
      expect(onMoveCancel).toHaveBeenCalledTimes(1);
      fireEvent.pointerMove(hit, { pointerId: 7, clientX: 100, clientY: 10 });
      fireEvent.pointerUp(hit, { pointerId: 7, clientX: 100, clientY: 10 });
      expect(onMovePreview).toHaveBeenCalledTimes(1);
      expect(onMoveCommit).not.toHaveBeenCalled();
    },
  );

  it("keeps body ownership through foreign down and terminal events", () => {
    const onSelectClip = vi.fn();
    const onMovePreview = vi.fn();
    const onMoveCommit = vi.fn();
    const onMoveCancel = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelect={vi.fn()}
        onHit={vi.fn()}
        onSelectClip={onSelectClip}
        onMovePreview={onMovePreview}
        onMoveCommit={onMoveCommit}
        onMoveCancel={onMoveCancel}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, {
      pointerId: 1,
      pointerType: "mouse",
      button: 2,
      clientX: 40,
    });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 80 });
    expect(onSelectClip).not.toHaveBeenCalled();
    fireEvent.pointerDown(hit, { pointerId: 7, clientX: 40, clientY: 10 });
    fireEvent.pointerDown(hit, { pointerId: 8, clientX: 40, clientY: 10 });
    for (const event of [
      fireEvent.pointerMove,
      fireEvent.pointerCancel,
      fireEvent.lostPointerCapture,
      fireEvent.pointerUp,
    ])
      event(hit, { pointerId: 8, clientX: 80, clientY: 10 });
    expect(onSelectClip).toHaveBeenCalledTimes(1);
    expect(onMoveCancel).not.toHaveBeenCalled();
    expect(onMovePreview).not.toHaveBeenCalled();
    fireEvent.pointerMove(hit, { pointerId: 7, clientX: 80, clientY: 10 });
    fireEvent.pointerUp(hit, { pointerId: 7, clientX: 80, clientY: 10 });
    expect(onMoveCommit).toHaveBeenCalledTimes(1);
  });

  it("ends body keyboard ownership synchronously after cancellation", () => {
    const ancestorKeys = vi.fn();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { container } = render(
      <div role="presentation" onKeyDown={ancestorKeys}>
        <ClipBlock {...base} canMove onSelect={vi.fn()} onHit={vi.fn()} />
      </div>,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 7, clientX: 40 });
    const listener = add.mock.calls.find(([type]) => type === "keydown")!;
    expect(listener[2]).toBe(true);
    for (const key of [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "Enter",
      " ",
      "Escape",
    ])
      fireEvent.keyDown(hit, { key });
    expect(ancestorKeys).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("keydown", listener[1], true);
    fireEvent.keyDown(hit, { key: "Home" });
    expect(ancestorKeys).toHaveBeenCalledTimes(1);
  });

  it("refuses body movement during an in-flight document join", () => {
    useDawStore.setState({ joinMutationInFlight: true });
    const onMovePreview = vi.fn();
    const onMoveCommit = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelect={vi.fn()}
        onHit={vi.fn()}
        onMovePreview={onMovePreview}
        onMoveCommit={onMoveCommit}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 7, clientX: 40 });
    fireEvent.pointerMove(hit, { pointerId: 7, clientX: 80 });
    fireEvent.pointerUp(hit, { pointerId: 7, clientX: 80 });
    expect(onMovePreview).not.toHaveBeenCalled();
    expect(onMoveCommit).not.toHaveBeenCalled();
    useDawStore.setState({ joinMutationInFlight: false });
  });

  it("abandons a body preview when the committed source geometry changes", () => {
    const onMoveCancel = vi.fn();
    const onMoveCommit = vi.fn();
    const props = {
      ...base,
      canMove: true,
      onSelect: vi.fn(),
      onHit: vi.fn(),
      onMoveCancel,
      onMoveCommit,
    };
    const view = render(<ClipBlock {...props} />);
    const hit = view.container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 7, clientX: 40 });
    fireEvent.pointerMove(hit, { pointerId: 7, clientX: 80 });
    view.rerender(
      <ClipBlock
        {...props}
        clip={{ ...clip, timeline_start: 5, timeline_end: 7 }}
      />,
    );
    expect(onMoveCancel).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(hit, { pointerId: 7, clientX: 80 });
    expect(onMoveCommit).not.toHaveBeenCalled();
  });

  it("cancels a body drag on lost pointer capture", () => {
    const onMovePreview = vi.fn();
    const onMoveCommit = vi.fn();
    const onMoveCancel = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelectClip={vi.fn()}
        onMovePreview={onMovePreview}
        onMoveCommit={onMoveCommit}
        onMoveCancel={onMoveCancel}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 40, clientY: 10, pointerId: 7 });
    fireEvent.pointerMove(hit, { clientX: 80, clientY: 10, pointerId: 7 });
    expect(onMovePreview).toHaveBeenCalled();
    fireEvent.lostPointerCapture(hit, { pointerId: 7 });
    expect(onMoveCancel).toHaveBeenCalled();
    expect(onMoveCommit).not.toHaveBeenCalled();
  });

  it("a touch hold selects once on pointerdown and never moves or reselects", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const onSelectClip = vi.fn();
    const onMoveCommit = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onSelect={onSelect}
        onSelectClip={onSelectClip}
        onMoveCommit={onMoveCommit}
      />,
    );
    const hit = container.querySelector(".clip-hit") as HTMLElement;
    const touch = { pointerType: "touch", isPrimary: true, pointerId: 8 };
    fireEvent.pointerDown(hit, { ...touch, clientX: 40, clientY: 10 });
    vi.advanceTimersByTime(700);
    fireEvent.pointerUp(hit, { ...touch, clientX: 42, clientY: 10 });
    fireEvent.lostPointerCapture(hit, { pointerId: 8 });
    fireEvent.click(hit);
    vi.runOnlyPendingTimers();
    expect(onSelectClip).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMoveCommit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("hides ghost clips from the accessibility tree", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        interactive={false}
        prevClip={clip}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(
      container.querySelector(".clip-block")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(container.querySelector(".join-seam")).toBeNull();
    expect(container.querySelector(".clip-hit")).toBeNull();
  });

  it("paints applied mute regions on the clip", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          mute_regions: [{ start_s: 0.5, end_s: 1.0 }],
        }}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    expect(container.querySelector(".clip-mute-region")).toBeTruthy();
  });

  it("tints the span where the recording clipped", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          source_start: 0,
          source_end: 2,
          clipping_regions: [
            { start_s: 0.5, end_s: 1.0 },
            { start_s: 5, end_s: 6 },
          ],
        }}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const tints = container.querySelectorAll(".clip-clipping-region");
    expect(tints).toHaveLength(1);
    expect(tints[0]?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps trim-handle drags off the body-move path", () => {
    const onMovePreview = vi.fn();
    const { container } = render(
      <ClipBlock
        {...base}
        canMove
        onMovePreview={onMovePreview}
        onRollPreview={vi.fn()}
        onSelect={vi.fn()}
        onHit={vi.fn()}
      />,
    );
    const handle = container.querySelector(".trim-handle.out") as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 5 });
    fireEvent.pointerMove(handle, { clientX: 160, pointerId: 5 });
    expect(onMovePreview).not.toHaveBeenCalled();
  });

  it("shows clip times to the millisecond in its tooltip", () => {
    const { container } = render(
      <ClipBlock
        {...base}
        clip={{
          ...clip,
          timeline_start: 1.23456,
          timeline_end: 3.23456,
        }}
      />,
    );
    const block = container.querySelector(".clip-block") as HTMLElement;
    expect(block.title).toBe("Select Dialogue clip at 00:01.234, 2s");
  });

  describe("join roll", () => {
    const prevClip: ClipRow = {
      ...clip,
      id: "c0",
      source_start: 0,
      source_end: 2,
      timeline_start: 0,
      timeline_end: 2,
    };
    const right: ClipRow = {
      ...clip,
      source_start: 4,
      source_end: 6,
      timeline_start: 2,
      timeline_end: 4,
    };
    const rollBy = (zoom: number, dxPx: number) => {
      const { container } = render(
        <ClipBlock
          {...base}
          clip={right}
          prevClip={prevClip}
          leftNeighborSourceEnd={0}
          zoomPxPerSec={zoom}
        />,
      );
      const seam = container.querySelector("button.join-seam") as HTMLElement;
      fireEvent.pointerDown(seam, { clientX: 100, pointerId: 7 });
      fireEvent.pointerUp(seam, { clientX: 100 + dxPx, pointerId: 7 });
    };

    beforeEach(() => {
      vi.mocked(rollClipJoin).mockClear();
    });

    it("commits a 3 px roll at deep zoom (a 62 µs join move)", async () => {
      rollBy(48000, 3);
      await waitFor(() => expect(rollClipJoin).toHaveBeenCalledTimes(1));
      const delta = vi.mocked(rollClipJoin).mock.calls[0]?.[3];
      expect(delta).toBeCloseTo(3 / 48000, 12);
    });

    it("skips a roll under the drag threshold", async () => {
      rollBy(50, 0.4);
      await new Promise((r) => setTimeout(r, 0));
      expect(rollClipJoin).not.toHaveBeenCalled();
    });
  });
});

describe("ClipBlock snap points", () => {
  beforeEach(() => {
    layers.push([]);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  const base = {
    clip,
    trackId: "host",
    role: "dialogue",
    zoomPxPerSec: 50,
    color: "var(--clip-dialogue-0)",
    selected: false,
    mediaRef: "track:host",
    prevClip: null,
    nextClip: null,
    neighborSourceLo: 0,
    neighborSourceHi: 10,
    leftNeighborSourceEnd: 0,
    mediaDurationSec: 10,
    rollPreview: null,
    onRollPreview: vi.fn(),
    onSelect: vi.fn(),
    onHit: vi.fn(),
    onSelectClip: vi.fn(),
    onMovePreview: vi.fn(),
    onMoveCommit: vi.fn(),
    onMoveCancel: vi.fn(),
  } as const;

  function setSnapStore(overrides: { showSnapPoints?: boolean } = {}) {
    const { showSnapPoints = true } = overrides;
    useDawStore.setState({
      projectPath: "/tmp/p.json",
      guestMode: null,
      isPlaying: false,
      playheadSec: 1,
      bladeHoverSec: null,
      layers: { ...useDawStore.getState().layers, showSnapPoints },
    });
  }

  it("loads ticks for the paused playhead but does not draw them in select mode", async () => {
    setSnapStore();
    const { container } = render(<ClipBlock {...base} />);
    const { loadWaveformSnap } = await import("../api");
    await waitFor(() => expect(loadWaveformSnap).toHaveBeenCalled());
    expect(container.querySelector(".clip-waveform-snap")).toBeNull();
  });

  it("draws ticks in blade mode", async () => {
    setSnapStore();
    const { container } = render(<ClipBlock {...base} bladeMode />);
    await waitFor(() =>
      expect(container.querySelectorAll(".clip-waveform-snap").length).toBe(1),
    );
  });

  it("does not draw ticks in blade mode when Snap points is off", async () => {
    setSnapStore({ showSnapPoints: false });
    const { container } = render(<ClipBlock {...base} bladeMode />);
    const { loadWaveformSnap } = await import("../api");
    await waitFor(() => expect(loadWaveformSnap).toHaveBeenCalled());
    expect(container.querySelector(".clip-waveform-snap")).toBeNull();
  });

  it("still magnets a trim to hidden ticks when Snap points is off", async () => {
    setSnapStore({ showSnapPoints: false });
    const { container } = render(<ClipBlock {...base} />);
    const { loadWaveformSnap } = await import("../api");
    await waitFor(() => expect(loadWaveformSnap).toHaveBeenCalled());
    expect(container.querySelector(".clip-waveform-snap")).toBeNull();
  });
});

describe("ClipBlockView", () => {
  // A non-literal value keeps Biome's ARIA-role-name check from reading this
  // domain prop (speaker role, not an ARIA role) as an invalid role="dialogue".
  const dialogueRole = "dialogue";
  const prev = clipRow({
    id: "prev",
    source_start: 0,
    source_end: 2,
    timeline_start: -2,
    timeline_end: 0,
  });
  const restGeometry = clipBlockGeometry({
    clip,
    zoomPxPerSec: 50,
    rollPreview: null,
    trimPreview: null,
    fadePreview: null,
    previewTimelineStart: null,
  });

  it("renders from props with handles and passes axe", async () => {
    const { container, getByRole } = render(
      <ClipBlockView
        clip={clip}
        role={dialogueRole}
        zoomPxPerSec={50}
        color="var(--lane-1)"
        selected={false}
        geometry={restGeometry}
        prevClip={prev}
        nextClip={null}
        showHandles
        hitHandlers={{ onClick: vi.fn() }}
      />,
    );
    expect(container.querySelectorAll(".trim-handle")).toHaveLength(2);
    expect(container.querySelector("button.join-seam")).not.toBeNull();
    expect(getByRole("button", { name: /^Select .+ clip at / })).not.toBeNull();
    await expectNoA11yViolations(container);
  });

  it("read-only clip shows the join as decoration and no handles", () => {
    const { container } = render(
      <ClipBlockView
        clip={clip}
        role={dialogueRole}
        zoomPxPerSec={50}
        color="var(--lane-1)"
        selected={false}
        geometry={restGeometry}
        prevClip={prev}
        nextClip={null}
        showHandles={false}
        hitHandlers={{ onClick: vi.fn() }}
      />,
    );
    expect(container.querySelector(".trim-handle")).toBeNull();
    const seam = container.querySelector("span.join-seam");
    expect(seam?.getAttribute("aria-hidden")).toBe("true");
  });

  it("routes handle pointerdowns by kind", () => {
    const onHandlePointerDown = vi.fn();
    const { container } = render(
      <ClipBlockView
        clip={clip}
        role={dialogueRole}
        zoomPxPerSec={50}
        color="var(--lane-1)"
        selected={false}
        geometry={restGeometry}
        prevClip={null}
        nextClip={null}
        showHandles
        hitHandlers={{ onClick: vi.fn() }}
        onHandlePointerDown={onHandlePointerDown}
      />,
    );
    const trimOut = container.querySelector(".trim-handle.out") as HTMLElement;
    fireEvent.pointerDown(trimOut, { pointerId: 1 });
    expect(onHandlePointerDown).toHaveBeenCalledWith(
      "trim-out",
      expect.anything(),
    );
    const fadeInZero = container.querySelector(
      "button.fade-corner.in.zero",
    ) as HTMLElement;
    fireEvent.pointerDown(fadeInZero, { pointerId: 1 });
    expect(onHandlePointerDown).toHaveBeenCalledWith(
      "fade-in",
      expect.anything(),
    );
  });

  it("spreads hit handlers onto the hit button", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <ClipBlockView
        clip={clip}
        role={dialogueRole}
        zoomPxPerSec={50}
        color="var(--lane-1)"
        selected={false}
        geometry={restGeometry}
        prevClip={null}
        nextClip={null}
        showHandles
        hitHandlers={{ onClick }}
      />,
    );
    fireEvent.click(getByRole("button", { name: /^Select .+ clip at / }));
    expect(onClick).toHaveBeenCalled();
  });

  it("renders waveform slots and snap ticks", () => {
    const ghostGeometry = clipBlockGeometry({
      clip,
      zoomPxPerSec: 50,
      rollPreview: null,
      trimPreview: {
        edge: "out",
        mode: "ripple",
        sourceStart: 0,
        sourceEnd: 2.5,
      },
      fadePreview: null,
      previewTimelineStart: null,
    });
    const { container } = render(
      <ClipBlockView
        clip={clip}
        role={dialogueRole}
        zoomPxPerSec={50}
        color="var(--lane-1)"
        selected={false}
        geometry={ghostGeometry}
        prevClip={null}
        nextClip={null}
        showHandles
        hitHandlers={{ onClick: vi.fn() }}
        snapTicks={[0.5]}
        waveform={<div data-testid="wave" />}
        ghostWaveform={<div data-testid="ghost" />}
      />,
    );
    expect(container.querySelector('[data-testid="wave"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ghost"]')).not.toBeNull();
    const snap = container.querySelector(".clip-waveform-snap") as HTMLElement;
    expect(snap.style.left).toBe("25px");

    const { container: noGhost } = render(
      <ClipBlockView
        clip={clip}
        role={dialogueRole}
        zoomPxPerSec={50}
        color="var(--lane-1)"
        selected={false}
        geometry={restGeometry}
        prevClip={null}
        nextClip={null}
        showHandles
        hitHandlers={{ onClick: vi.fn() }}
        waveform={<div data-testid="wave2" />}
      />,
    );
    expect(noGhost.querySelector(".clip-trim-ghost")).toBeNull();
  });

  it("shows the fade readout for the dragged edge", () => {
    const fadeGeometry = clipBlockGeometry({
      clip,
      zoomPxPerSec: 50,
      rollPreview: null,
      trimPreview: null,
      fadePreview: { edge: "out", inMs: 0, outMs: 300 },
      previewTimelineStart: null,
    });
    const { container } = render(
      <ClipBlockView
        clip={clip}
        role={dialogueRole}
        zoomPxPerSec={50}
        color="var(--lane-1)"
        selected={false}
        geometry={fadeGeometry}
        prevClip={null}
        nextClip={null}
        showHandles
        hitHandlers={{ onClick: vi.fn() }}
      />,
    );
    expect(container.querySelector(".fade-readout.out")?.textContent).toBe(
      "300 ms",
    );
  });
});
