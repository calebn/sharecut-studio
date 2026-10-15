import { act, render, screen, within } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasValidFocusedFeedbackAction } from "../../feedback/feedbackActionFocus";
import { expectNoA11yViolations } from "../../test/a11y";
import { registerFocusHold } from "../../ui/focusHold";
import { closeOverlay, openOverlay } from "../../ui/modalGate";
import { useDialogModal } from "../../ui/useDialogModal";
import {
  EnvelopeWorkspaceView,
  type EnvelopeWorkspaceViewProps,
} from "./EnvelopeWorkspaceView";

const props: EnvelopeWorkspaceViewProps = {
  trackName: "Host",
  points: [],
  pointId: null,
  editable: true,
  levelsVisible: true,
  form: { kind: "add", pointId: "new", time: "-1", level: "1" },
  busy: false,
  error: null,
  collisionId: null,
  onSelect: vi.fn(),
  onAdd: vi.fn(),
  onEdit: vi.fn(),
  onChange: vi.fn(),
  onSave: vi.fn(),
  onCancel: vi.fn(),
  onDelete: vi.fn(),
  onReload: vi.fn(),
  onDone: vi.fn(),
  onToggleLevels: vi.fn(),
};

const rect = (top: number, height: number): DOMRect => ({
  top,
  bottom: top + height,
  height,
  left: 10,
  right: 190,
  width: 180,
  x: 10,
  y: top,
  toJSON: () => ({}),
});

describe("envelope initial focus", () => {
  let nextFrame = 0;
  let frames: Map<number, FrameRequestCallback>;
  const extraNodes: HTMLElement[] = [];
  const overlays: ReturnType<typeof openOverlay>[] = [];
  let unregisterHold: () => void;
  beforeEach(() => {
    unregisterHold = registerFocusHold(hasValidFocusedFeedbackAction);
    frames = new Map();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });
  afterEach(() => {
    for (const node of extraNodes.splice(0)) node.remove();
    for (const layer of overlays.splice(0)) closeOverlay(layer);
    unregisterHold();
    vi.restoreAllMocks();
  });
  function flushFrames() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of pending) callback(0);
    });
  }
  function outsideControl() {
    const button = document.createElement("button");
    document.body.append(button);
    extraNodes.push(button);
    return button;
  }

  it("waits through detached feedback host registration and yields after the native action returns", () => {
    const feedback = document.createElement("div");
    feedback.className = "ui-toast-region--app";
    const dismiss = document.createElement("button");
    dismiss.setAttribute("data-feedback-focus", "");
    feedback.append(dismiss);
    extraNodes.push(feedback);
    document.body.append(feedback);
    dismiss.focus();
    feedback.remove();
    expect(document.activeElement).toBe(document.body);
    render(<EnvelopeWorkspaceView {...props} form={null} />);
    expect(document.activeElement).toBe(document.body);
    document.body.append(feedback);
    act(() => dismiss.focus());
    flushFrames();
    expect(dismiss).toHaveFocus();
  });

  it("does not steal focus later when first entry was requested while hidden", () => {
    const outside = outsideControl();
    const first = { id: "p1", time: 1, value: 1 };
    const onePoint = [first];
    const twoPoints = [first, { id: "p2", time: 9, value: 1 }];
    const view = (points: typeof onePoint, hidden: boolean) => (
      <div style={{ display: hidden ? "none" : "block" }}>
        <EnvelopeWorkspaceView {...props} form={null} points={points} />
      </div>
    );
    const { rerender } = render(view(onePoint, true));
    flushFrames();
    rerender(view(onePoint, false));
    flushFrames();
    act(() => outside.focus());
    rerender(view(twoPoints, false));
    flushFrames();
    expect(outside).toHaveFocus();
  });

  it("yields only first entry to an intentionally focused feedback action and preserves form entry", () => {
    const feedback = document.createElement("div");
    feedback.className = "ui-toast-region--app";
    const dismiss = document.createElement("button");
    dismiss.setAttribute("data-feedback-focus", "");
    feedback.append(dismiss);
    document.body.append(feedback);
    extraNodes.push(feedback);
    dismiss.focus();
    const { rerender } = render(
      <EnvelopeWorkspaceView {...props} form={null} />,
    );
    flushFrames();
    expect(dismiss).toHaveFocus();
    rerender(<EnvelopeWorkspaceView {...props} />);
    expect(screen.getByLabelText("Time (seconds on timeline)")).toHaveFocus();
  });

  it("completes ordinary first entry after StrictMode replays the canceled initial frame", () => {
    render(
      <StrictMode>
        <EnvelopeWorkspaceView {...props} form={null} />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(document.body);
    flushFrames();
    expect(screen.getByRole("button", { name: "Add point" })).toHaveFocus();
  });

  it("cancels pending first entry when form entry immediately focuses Time", () => {
    const { rerender } = render(
      <EnvelopeWorkspaceView {...props} form={null} />,
    );
    expect(document.activeElement).toBe(document.body);
    rerender(<EnvelopeWorkspaceView {...props} />);
    expect(screen.getByLabelText("Time (seconds on timeline)")).toHaveFocus();
    const save = screen.getByRole("button", { name: "Save point" });
    act(() => save.focus());
    flushFrames();
    expect(save).toHaveFocus();
  });

  it.each(["navigation", "modal", "unmount"])(
    "does not steal focus after %s before initial entry settles",
    (change) => {
      const outside = outsideControl();
      const { unmount } = render(
        <EnvelopeWorkspaceView {...props} form={null} />,
      );
      expect(document.activeElement).toBe(document.body);
      if (change === "modal") overlays.push(openOverlay(true));
      if (change === "unmount") unmount();
      act(() => outside.focus());
      flushFrames();
      expect(outside).toHaveFocus();
    },
  );

  it("preserves ordinary new sheet Close ordering after deferred envelope entry", () => {
    function Sheet() {
      const panelRef = useRef<HTMLDivElement>(null);
      const closeRef = useRef<HTMLButtonElement>(null);
      useDialogModal({
        open: true,
        onClose: vi.fn(),
        panelRef,
        initialFocusRef: closeRef,
        mode: "sheet",
      });
      return (
        <div ref={panelRef}>
          <button ref={closeRef} type="button">
            Close ordinary sheet
          </button>
          <EnvelopeWorkspaceView {...props} form={null} />
        </div>
      );
    }
    render(<Sheet />);
    flushFrames();
    expect(
      screen.getByRole("button", { name: "Close ordinary sheet" }),
    ).toHaveFocus();
  });
});

describe("selected envelope nudge controls", () => {
  it("does not let visibility change while a nudge is active", () => {
    render(<EnvelopeWorkspaceView {...props} nudgeActive />);
    expect(
      screen.getByRole("button", { name: "Hide volume envelope" }),
    ).toBeDisabled();
  });

  it("offers timeline steps and half-dB steps, disabling a downward step from silence", async () => {
    const run = {
      buttonProps: vi.fn(() => ({})),
      saving: false,
      bump: null,
    } as unknown as NonNullable<EnvelopeWorkspaceViewProps["nudgeRun"]>;
    const point = { id: "p1", time: 12.345, value: 0 };
    const { container } = render(
      <EnvelopeWorkspaceView
        {...props}
        trackId="host"
        nudgeRun={run}
        points={[point]}
        pointId="p1"
        form={null}
      />,
    );
    const time = screen.getByRole("group", { name: "Nudge envelope time" });
    expect(
      within(time).getByRole("button", { name: "10 ms earlier" }),
    ).toBeEnabled();
    expect(
      within(time).getByRole("button", { name: "100 ms later" }),
    ).toBeEnabled();
    const level = screen.getByRole("group", { name: "Nudge envelope level" });
    expect(
      within(level).getByRole("button", { name: "0.5 dB lower" }),
    ).toBeDisabled();
    expect(
      within(level).getByRole("button", { name: "0.5 dB higher" }),
    ).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it("does not expose nudge controls while a typed edit form is active", () => {
    const run = {
      buttonProps: vi.fn(() => ({})),
      saving: false,
      bump: null,
    } as unknown as NonNullable<EnvelopeWorkspaceViewProps["nudgeRun"]>;
    render(
      <EnvelopeWorkspaceView
        {...props}
        trackId="host"
        nudgeRun={run}
        points={[{ id: "p1", time: 12, value: 0.5 }]}
        pointId="p1"
      />,
    );
    expect(
      screen.queryByRole("group", { name: "Nudge envelope time" }),
    ).toBeNull();
  });
});

describe("envelope error focus", () => {
  it("keeps the current Save control focused and locally visible after an error reflow", () => {
    const { container, rerender } = render(
      <div className="bottom-sheet" style={{ overflowY: "auto" }}>
        <EnvelopeWorkspaceView {...props} />
      </div>,
    );
    const sheet = container.firstElementChild as HTMLElement;
    Object.defineProperties(sheet, {
      clientHeight: { value: 200 },
      clientWidth: { value: 200 },
      scrollHeight: { value: 1000 },
    });
    sheet.getBoundingClientRect = () => rect(0, 200);
    const save = screen.getByRole("button", { name: "Save point" });
    save.getBoundingClientRect = () => rect(300 - sheet.scrollTop, 88);
    act(() => save.focus());
    rerender(
      <div className="bottom-sheet" style={{ overflowY: "auto" }}>
        <EnvelopeWorkspaceView
          {...props}
          error={{ target: "time", message: "Time must be zero or later." }}
        />
      </div>,
    );
    expect(save).toHaveFocus();
    expect(sheet.scrollTop).toBe(188);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("reveals the complete Time label and error when keyboard focus returns", () => {
    const { container } = render(
      <div className="bottom-sheet" style={{ overflowY: "auto" }}>
        <EnvelopeWorkspaceView
          {...props}
          error={{ target: "time", message: "Time must be zero or later." }}
        />
      </div>,
    );
    const sheet = container.firstElementChild as HTMLElement;
    Object.defineProperties(sheet, {
      clientHeight: { value: 300 },
      clientWidth: { value: 200 },
      scrollHeight: { value: 1000 },
    });
    sheet.getBoundingClientRect = () => rect(0, 300);
    const time = screen.getByLabelText("Time (seconds on timeline)");
    const label = time.closest("label")!;
    label.getBoundingClientRect = () => rect(400 - sheet.scrollTop, 150);
    time.getBoundingClientRect = () => rect(462 - sheet.scrollTop, 88);
    const error = screen.getByRole("alert");
    error.getBoundingClientRect = () => rect(560 - sheet.scrollTop, 70);
    act(() => screen.getByRole("button", { name: "Save point" }).focus());
    act(() => time.focus());
    expect(time).toHaveFocus();
    expect(sheet.scrollTop).toBe(330);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("does not reclaim focus from outside the workspace on error", () => {
    const { rerender } = render(
      <>
        <button type="button">Timeline</button>
        <EnvelopeWorkspaceView {...props} />
      </>,
    );
    const outside = screen.getByRole("button", { name: "Timeline" });
    act(() => outside.focus());
    rerender(
      <>
        <button type="button">Timeline</button>
        <EnvelopeWorkspaceView
          {...props}
          error={{ target: "form", message: "Save failed. Try again." }}
        />
      </>,
    );
    expect(outside).toHaveFocus();
  });
});
