import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { formatGainDb } from "../utils/audio";
import { TrackFaderView, type TrackFaderViewProps } from "./TrackFaderView";

const props: TrackFaderViewProps = {
  trackLabel: "Mira voice",
  savedDb: -3,
  access: { kind: "read-only" },
  presentation: { kind: "compact" },
};
const field = () =>
  screen.getByRole("spinbutton", { name: "Volume Mira voice" });

describe("TrackFaderView", () => {
  it("is a level Scrub field: a key press saves one volume", () => {
    const onCommit = vi.fn();
    render(<TrackFaderView {...props} access={{ kind: "edit", onCommit }} />);
    expect(field()).toHaveAttribute("aria-valuenow", "-3");
    expect(screen.queryByRole("slider")).toBeNull();
    field().focus();
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toBeGreaterThan(-3);
  });

  it("the number follows a drag and returns to the saved level when it is cancelled", () => {
    const onCommit = vi.fn();
    render(<TrackFaderView {...props} access={{ kind: "edit", onCommit }} />);
    fireEvent.pointerDown(field(), { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(field(), { pointerId: 1, clientX: 110 });
    fireEvent.pointerMove(field(), { pointerId: 1, clientX: 150 });
    expect(Number(field().getAttribute("aria-valuenow"))).toBeGreaterThan(-3);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field()).toHaveAttribute("aria-valuenow", "-3");
  });

  it("read-only access commits nothing", () => {
    const onCommit = vi.fn();
    render(<TrackFaderView {...props} />);
    expect(field()).toHaveAttribute("aria-readonly", "true");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("hands the saved base gain to the plays-at line", () => {
    render(
      <TrackFaderView
        {...props}
        presentation={{
          kind: "compact",
          stagingDb: -2,
          playsAt: (baseDb) => (
            <span data-testid="plays-at">{formatGainDb(baseDb - 4)}</span>
          ),
        }}
        access={{ kind: "edit", onCommit: vi.fn() }}
      />,
    );
    expect(screen.getByTestId("plays-at")).toHaveTextContent("−9.0 dB");
  });

  it("without an envelope shows no plays-at line", async () => {
    const view = render(<TrackFaderView {...props} />);
    expect(screen.queryByText(/^Plays at/)).toBeNull();
    await expectNoA11yViolations(view.container);
  });

  it("follows saved undo and collaborator updates", () => {
    const view = render(<TrackFaderView {...props} />);
    view.rerender(<TrackFaderView {...props} savedDb={1.5} />);
    expect(field()).toHaveAttribute("aria-valuenow", "1.5");
  });
});
