import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundaryAudition, BoundaryContext } from "../api/boundary";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { PrecisionBoundaryDialog } from "./PrecisionBoundaryDialog";

const { loadBoundaryContext, auditionBoundary } = vi.hoisted(() => ({
  loadBoundaryContext: vi.fn(),
  auditionBoundary: vi.fn(),
}));

vi.mock("../api/boundary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/boundary")>();
  return { ...actual, loadBoundaryContext, auditionBoundary };
});

const target = {
  kind: "trim" as const,
  clip_id: "clip-1",
  edge: "out" as const,
};
const geometry = [
  {
    id: "clip-1",
    source_start: 1,
    source_end: 4,
    timeline_start: 10,
    source_id: null,
  },
];
const context: BoundaryContext = {
  target,
  token: "context-token",
  track_id: "host",
  geometry,
  current: { source_sec: 4, timeline_sec: 13 },
  limits: { min: 1.05, max: 5, fine_step_sec: 0.001, regular_step_sec: 0.01 },
};
const audition: BoundaryAudition = {
  token: "audition-token",
  actual_edit: { ...target, source_sec: 3.875, mode: "ripple" },
  current: {
    url: "/api/boundary/audio/current",
    window_start_sec: 12,
    window_end_sec: 14,
    duration_sec: 2,
    seam_offset_sec: 1,
  },
  proposed: {
    url: "/api/boundary/audio/proposed",
    window_start_sec: 11.8,
    window_end_sec: 13.8,
    duration_sec: 2,
    seam_offset_sec: 1.1,
  },
};

function boundaryProps(
  overrides: Partial<ComponentProps<typeof PrecisionBoundaryDialog>> = {},
) {
  return {
    open: true,
    onClose: vi.fn(),
    projectPath: "/tmp/episode.json",
    target,
    expectedGeometry: geometry,
    boundary: {
      id: "eb:clip-1",
      track_id: "host",
      left_clip_id: "clip-1",
      right_clip_id: null,
      timeline_join_sec: 13,
      cutaway_source_start: 4,
      cutaway_source_end: 6,
      has_cutaway: true,
      cutaway_word_ids: [
        {
          track_id: "host",
          source_id: null,
          word_index: 2,
          text: "hello",
          start: 4.1,
          end: 4.4,
        },
      ],
    },
    onApply: vi.fn(async () => ({ queued: false })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDawStore.getState().hydrate("/tmp/episode.json", minimalProject());
  loadBoundaryContext.mockResolvedValue(context);
  auditionBoundary.mockResolvedValue(audition);
});

describe("PrecisionBoundaryDialog", () => {
  it("uses signed trim offsets with 1 ms and 10 ms adjustments", async () => {
    render(<PrecisionBoundaryDialog {...boundaryProps()} />);
    const input = await screen.findByRole("spinbutton", {
      name: "Change boundary by (seconds)",
    });
    expect(input).toHaveValue(0);
    await expectNoA11yViolations(document.body);
    fireEvent.click(
      screen.getByRole("button", { name: "Adjust by plus 1 millisecond" }),
    );
    expect(input).toHaveValue(0.001);
    fireEvent.click(
      screen.getByRole("button", { name: "Adjust by minus 10 milliseconds" }),
    );
    expect(input).toHaveValue(-0.009);
    expect(screen.getByText("3.991 s")).toBeInTheDocument();
  });

  it("keeps the signed number editable through an empty intermediate value", async () => {
    const user = userEvent.setup();
    const props = boundaryProps();
    render(<PrecisionBoundaryDialog {...props} />);
    const input = await screen.findByRole("spinbutton", {
      name: "Change boundary by (seconds)",
    });
    await user.clear(input);
    expect(input).toHaveValue(null);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.type(input, "-0.123");
    expect(input).toHaveValue(-0.123);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(props.onApply).toHaveBeenCalledWith(
        { ...target, source_sec: 3.877, mode: "ripple" },
        "context-token",
      ),
    );
  });

  it("rejects a typed offset outside the displayed legal range", async () => {
    const props = boundaryProps();
    render(<PrecisionBoundaryDialog {...props} />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(input).toHaveValue(1.5);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("-2.950 s to 1.000 s");
    expect(
      screen.getByRole("button", { name: "Listen proposed" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(auditionBoundary).not.toHaveBeenCalled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it.each(["0.0004", "0.0006"])(
    "rejects sub-millisecond typed offset %s instead of applying a rounded value",
    async (typed) => {
      const props = boundaryProps();
      render(<PrecisionBoundaryDialog {...props} />);
      const input = await screen.findByRole("spinbutton");
      fireEvent.change(input, { target: { value: typed } });
      expect(input).toHaveValue(Number(typed));
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent("whole-millisecond");
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Listen proposed" }),
      ).toBeDisabled();
      expect(props.onApply).not.toHaveBeenCalled();
    },
  );

  it("auditions a proposed trim from the signed offset and starts the owned rendered preview", async () => {
    render(<PrecisionBoundaryDialog {...boundaryProps()} />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "-0.125" } });
    fireEvent.click(screen.getByRole("button", { name: "Listen proposed" }));
    await waitFor(() =>
      expect(auditionBoundary).toHaveBeenCalledWith(
        "/tmp/episode.json",
        target,
        { ...target, source_sec: 3.875, mode: "ripple" },
        "context-token",
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview?.media).toEqual({
        kind: "rendered",
        url: "/api/boundary/audio/proposed?expected_token=audition-token",
      }),
    );
    expect(screen.getByText(/proposed seam 12\.900 s/)).toBeInTheDocument();
  });

  it("stops owned audio when a number edit passes through an empty value", async () => {
    render(<PrecisionBoundaryDialog {...boundaryProps()} />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.click(screen.getByRole("button", { name: "Listen current" }));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    fireEvent.change(input, { target: { value: "" } });
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("reuses the ready pair after playback is blocked and exposes a retry action", async () => {
    render(<PrecisionBoundaryDialog {...boundaryProps()} />);
    await screen.findByRole("spinbutton");
    fireEvent.click(screen.getByRole("button", { name: "Listen proposed" }));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview?.media).toEqual({
        kind: "rendered",
        url: "/api/boundary/audio/proposed?expected_token=audition-token",
      }),
    );

    const preview = useDawStore.getState().sourcePreview;
    if (!preview) throw new Error("Expected an owned preview");
    useDawStore
      .getState()
      .updateSourcePreview(preview.ownerId, preview.generation, 0, true, {
        kind: "blocked",
        message:
          "Browser blocked playback. Select the audio control again to try.",
      });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Select the audio control again to try",
    );

    fireEvent.click(screen.getByRole("button", { name: "Listen proposed" }));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview?.media).toEqual({
        kind: "rendered",
        url: "/api/boundary/audio/proposed?expected_token=audition-token",
      }),
    );
    expect(auditionBoundary).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().sourcePreviewError).toBeNull();
  });

  it("prepares a fresh pair after the issued media becomes unavailable", async () => {
    render(<PrecisionBoundaryDialog {...boundaryProps()} />);
    await screen.findByRole("spinbutton");
    fireEvent.click(screen.getByRole("button", { name: "Listen proposed" }));
    await waitFor(() => expect(auditionBoundary).toHaveBeenCalledTimes(1));
    const preview = useDawStore.getState().sourcePreview;
    if (!preview) throw new Error("Expected an owned preview");
    act(() =>
      useDawStore
        .getState()
        .updateSourcePreview(preview.ownerId, preview.generation, 0, true, {
          kind: "unavailable",
          message: "The audition expired. Listen again.",
        }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("expired");
    fireEvent.click(screen.getByRole("button", { name: "Listen proposed" }));
    await waitFor(() => expect(auditionBoundary).toHaveBeenCalledTimes(2));
  });

  it("distinguishes complete ghost spans from a partial zero length word span", async () => {
    const props = boundaryProps({
      boundary: {
        ...boundaryProps().boundary,
        cutaway_source_start: 4,
        cutaway_source_end: 4.1,
        cutaway_word_ids: [
          {
            track_id: "host",
            source_id: null,
            word_index: 1,
            text: "whole",
            start: 4.01,
            end: 4.04,
          },
          {
            track_id: "host",
            source_id: null,
            word_index: 2,
            text: "partial",
            start: 4.0995,
            end: 4.0995,
          },
        ],
      },
    });
    render(<PrecisionBoundaryDialog {...props} />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.1" } });
    expect(screen.getByText("whole").parentElement).toHaveTextContent(
      "full source span",
    );
    expect(screen.getByText("partial").parentElement).toHaveTextContent(
      "partial source span",
    );
  });

  it("does not save an unchanged boundary and sends expected_token for a changed trim", async () => {
    const onClose = vi.fn();
    const props = boundaryProps({ onClose });
    const first = render(<PrecisionBoundaryDialog {...props} />);
    await screen.findByRole("spinbutton");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    first.unmount();
    onClose.mockClear();
    render(<PrecisionBoundaryDialog {...props} />);
    const changedInput = await screen.findByRole("spinbutton");
    fireEvent.change(changedInput, { target: { value: "0.125" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(props.onApply).toHaveBeenCalledWith(
        { ...target, source_sec: 4.125, mode: "ripple" },
        "context-token",
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps queued work visibly pending and prevents a duplicate Apply", async () => {
    const props = boundaryProps({
      onApply: vi.fn(async () => ({ queued: true })),
    });
    render(<PrecisionBoundaryDialog {...props} />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "queued for sync",
    );
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  it("retains the draft after a failed save so Apply can be retried", async () => {
    const onApply = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary save failure"))
      .mockResolvedValueOnce({ queued: false });
    render(<PrecisionBoundaryDialog {...boundaryProps({ onApply })} />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.125" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "temporary save failure",
    );
    expect(input).toHaveValue(0.125);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
  });

  it("offers a context reload after a stale geometry response", async () => {
    loadBoundaryContext.mockRejectedValueOnce(
      new Error("409 stale boundary geometry"),
    );
    render(<PrecisionBoundaryDialog {...boundaryProps()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "409 stale boundary geometry",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload boundary" }));
    expect(await screen.findByRole("spinbutton")).toBeInTheDocument();
    expect(loadBoundaryContext).toHaveBeenCalledTimes(2);
  });

  it("keeps the current draft when the parent recreates equal geometry", async () => {
    const props = boundaryProps();
    const view = render(<PrecisionBoundaryDialog {...props} />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.125" } });
    view.rerender(
      <PrecisionBoundaryDialog
        {...props}
        expectedGeometry={geometry.map((clip) => ({ ...clip }))}
      />,
    );
    expect(input).toHaveValue(0.125);
    expect(loadBoundaryContext).toHaveBeenCalledTimes(1);
  });

  it("ignores an aborted context load after close and reopen of the same project", async () => {
    let resolveOld: ((value: BoundaryContext) => void) | undefined;
    loadBoundaryContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const props = boundaryProps();
    const view = render(<PrecisionBoundaryDialog {...props} />);
    expect(loadBoundaryContext).toHaveBeenCalledTimes(1);
    view.rerender(<PrecisionBoundaryDialog {...props} open={false} />);
    view.rerender(<PrecisionBoundaryDialog {...props} open />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.125" } });
    await act(async () => resolveOld?.({ ...context, token: "old-token" }));
    expect(input).toHaveValue(0.125);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(props.onApply).toHaveBeenCalledWith(
        { ...target, source_sec: 4.125, mode: "ripple" },
        "context-token",
      ),
    );
  });

  it("reports guest permission without requesting host-only context or audio", async () => {
    useDawStore.setState({ guestMode: "review" });
    render(<PrecisionBoundaryDialog {...boundaryProps()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "available in the host editor",
    );
    expect(loadBoundaryContext).not.toHaveBeenCalled();
    expect(auditionBoundary).not.toHaveBeenCalled();
  });

  it("ignores a late audition after the draft changes", async () => {
    let resolveAudition: ((value: BoundaryAudition) => void) | undefined;
    auditionBoundary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAudition = resolve;
        }),
    );
    render(<PrecisionBoundaryDialog {...boundaryProps()} />);
    const input = await screen.findByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Listen proposed" }));
    fireEvent.change(input, { target: { value: "0.06" } });
    await act(async () => resolveAudition?.(audition));
    expect(useDawStore.getState().sourcePreview).toBeNull();
  });
});
