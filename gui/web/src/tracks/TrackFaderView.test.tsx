import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { formatGainDb } from "../utils/audio";
import { TrackFaderView, type TrackFaderViewProps } from "./TrackFaderView";

const props: TrackFaderViewProps = {
  trackLabel: "Mira voice",
  savedDb: -3,
  access: { kind: "read-only" },
  presentation: { kind: "compact", descriptionId: "permission" },
};
function ControlledFader({ onCommit }: { onCommit: (db: number) => void }) {
  const [savedDb, setSavedDb] = useState(-3);
  return (
    <TrackFaderView
      {...props}
      savedDb={savedDb}
      access={{
        kind: "edit",
        onCommit: (db) => {
          onCommit(db);
          setSavedDb(db);
        },
      }}
    />
  );
}
function slider() {
  return screen.getByRole("slider", { name: "Volume Mira voice" });
}

describe("TrackFaderView", () => {
  it("shares native drafts, commits and double-click reset", () => {
    const onCommit = vi.fn();
    render(
      <>
        <p id="permission">Saved volume</p>
        <TrackFaderView {...props} access={{ kind: "edit", onCommit }} />
      </>,
    );
    fireEvent.input(slider(), { target: { value: "-6" } });
    expect(slider()).toHaveValue("-6");
    expect(slider()).toHaveAttribute("aria-valuetext", "−6.0 dB");
    expect(screen.getByRole("status")).toHaveTextContent("−6.0 dB");
    expect(slider()).toHaveAccessibleDescription("Saved volume");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(slider(), { target: { value: "-6" } });
    expect(onCommit.mock.calls).toEqual([[-6]]);
    fireEvent.doubleClick(slider());
    expect(onCommit.mock.calls).toEqual([[-6], [0]]);
    expect(slider()).toHaveValue("0");
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
  });

  it("hands the draft base gain to the plays-at line", () => {
    render(
      <TrackFaderView
        {...props}
        presentation={{
          kind: "compact",
          descriptionId: "permission",
          stagingDb: -2,
          playsAt: (baseDb) => (
            <span data-testid="plays-at">{formatGainDb(baseDb - 4)}</span>
          ),
        }}
        access={{ kind: "edit", onCommit: vi.fn() }}
      />,
    );
    expect(screen.getByTestId("plays-at")).toHaveTextContent("−9.0 dB");
    fireEvent.input(slider(), { target: { value: "-6" } });
    expect(screen.getByTestId("plays-at")).toHaveTextContent("−12.0 dB");
  });

  it("without an envelope shows no plays-at line", () => {
    render(<TrackFaderView {...props} />);
    expect(screen.queryByText(/^Plays at/)).toBeNull();
  });

  it("double-click resets and native changes commit keyboard-sized steps", () => {
    const onCommit = vi.fn();
    render(<ControlledFader onCommit={onCommit} />);
    fireEvent.change(slider(), { target: { value: "-2.5" } });
    expect(slider()).toHaveValue("-2.5");
    expect(onCommit.mock.calls).toEqual([[-2.5]]);
    fireEvent.doubleClick(slider());
    expect(slider()).toHaveValue("0");
    expect(onCommit.mock.calls).toEqual([[-2.5], [0]]);
  });
  it.each(["pointerUp", "pointerCancel", "blur"] as const)(
    "resumes saved updates after %s ends a draft",
    (event) => {
      const onCommit = vi.fn();
      const access = { kind: "edit" as const, onCommit };
      const view = render(<TrackFaderView {...props} access={access} />);
      fireEvent.input(slider(), { target: { value: "-6" } });
      view.rerender(
        <TrackFaderView {...props} savedDb={1.5} access={access} />,
      );
      expect(slider()).toHaveValue("-6");
      fireEvent[event](slider());
      view.rerender(<TrackFaderView {...props} savedDb={2} access={access} />);
      expect(slider()).toHaveValue("2");
      expect(onCommit).not.toHaveBeenCalled();
      fireEvent.input(slider(), { target: { value: "2.5" } });
      fireEvent.change(slider());
      expect(onCommit.mock.calls).toEqual([[2.5]]);
    },
  );
  it("follows saved undo and collaborator updates without a draft", () => {
    const view = render(<TrackFaderView {...props} />);
    view.rerender(<TrackFaderView {...props} savedDb={1.5} />);
    expect(slider()).toHaveValue("1.5");
    expect(screen.getByRole("status")).toHaveTextContent("+1.5 dB");
    view.rerender(<TrackFaderView {...props} savedDb={-3} />);
    expect(slider()).toHaveValue("-3");
  });
  it("revoked access disables the range and stops a pending native commit", async () => {
    const onCommit = vi.fn();
    const view = render(
      <>
        <p id="permission">Only the host and editors can change the volume.</p>
        <TrackFaderView {...props} access={{ kind: "edit", onCommit }} />
      </>,
    );
    fireEvent.change(slider(), { target: { value: "-2.5" } });
    expect(onCommit.mock.calls).toEqual([[-2.5]]);
    fireEvent.input(slider(), { target: { value: "-6" } });
    view.rerender(
      <>
        <p id="permission">Only the host and editors can change the volume.</p>
        <TrackFaderView {...props} />
      </>,
    );
    expect(slider()).toBeDisabled();
    expect(slider()).toHaveAccessibleDescription(
      "Only the host and editors can change the volume.",
    );
    fireEvent.change(slider(), { target: { value: "-6" } });
    fireEvent.doubleClick(slider());
    expect(onCommit.mock.calls).toEqual([[-2.5]]);
    await expectNoA11yViolations(view.container);
  });
  it("associates each output with its own same-track input", async () => {
    const view = render(
      <>
        <TrackFaderView {...props} />
        <TrackFaderView {...props} />
      </>,
    );
    const sliders = screen.getAllByRole("slider", {
      name: "Volume Mira voice",
    });
    expect(new Set(sliders.map((input) => input.id)).size).toBe(2);
    sliders.forEach((input) => {
      expect(
        view.container.querySelector(`output[for="${input.id}"]`),
      ).toHaveTextContent("−3.0 dB");
    });
    await expectNoA11yViolations(view.container);
  });
});
