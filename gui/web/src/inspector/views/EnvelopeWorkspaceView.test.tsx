import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EnvelopeWorkspaceView,
  type EnvelopeWorkspaceViewProps,
} from "./EnvelopeWorkspaceView";

const props: EnvelopeWorkspaceViewProps = {
  trackName: "Host",
  points: [],
  pointId: null,
  editable: true,
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
