import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import type { TakeClipping } from "./keeper/clipRegions";
import { TakeClippingReport } from "./TakeClippingReport";
import {
  CLIPPING_JUNCTION_HINT,
  CLIPPING_RECOVERY_COPY,
  clippingLiveCopy,
  clippingReportCopy,
  NO_CLIPPING_COPY,
} from "./types";

const clipped: TakeClipping = {
  takeIndex: 1,
  known: true,
  regions: [
    { segmentIndex: 0, startMs: 65_000, endMs: 66_000, segmentStartMs: 65_000 },
    {
      segmentIndex: 0,
      startMs: 130_000,
      endMs: 131_000,
      segmentStartMs: 130_000,
    },
  ],
};

describe("TakeClippingReport", () => {
  it("renders nothing without a report", () => {
    const { container } = render(
      <TakeClippingReport report={null} roomState="stopped" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("warns live while recording, and stays quiet with no clips", () => {
    const { rerender } = render(
      <TakeClippingReport report={clipped} roomState="recording" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(clippingLiveCopy(2));
    rerender(
      <TakeClippingReport
        report={{ ...clipped, regions: [] }}
        roomState="recording"
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<TakeClippingReport report={clipped} roomState="lobby" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lists ranges after stop without jump buttons for guests", async () => {
    const { container } = render(
      <TakeClippingReport report={clipped} roomState="stopped" />,
    );
    expect(
      screen.getByRole("heading", { name: "Clipping report" }),
    ).toBeInTheDocument();
    expect(screen.getByText(clippingReportCopy(2, 1))).toBeInTheDocument();
    expect(screen.getByText("1:05–1:06")).toBeInTheDocument();
    expect(screen.getByText(CLIPPING_RECOVERY_COPY)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("offers Jump to when the take is on the timeline", async () => {
    const jump = vi.fn();
    const { container } = render(
      <TakeClippingReport
        report={clipped}
        roomState="stopped"
        jumpFor={() => jump}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /Jump to/ });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0] as HTMLElement);
    expect(jump).toHaveBeenCalledOnce();
    expect(screen.queryByText(CLIPPING_JUNCTION_HINT)).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("disables Jump to until the take lands", async () => {
    const { container } = render(
      <TakeClippingReport
        report={clipped}
        roomState="stopped"
        jumpFor={() => null}
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByText(CLIPPING_JUNCTION_HINT)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("says no clipping only when every segment was checked", () => {
    const empty: TakeClipping = { takeIndex: 0, known: true, regions: [] };
    const { rerender } = render(
      <TakeClippingReport report={empty} roomState="stopped" />,
    );
    expect(screen.getByText(NO_CLIPPING_COPY)).toBeInTheDocument();
    rerender(
      <TakeClippingReport
        report={{ ...empty, known: false }}
        roomState="stopped"
      />,
    );
    expect(screen.queryByText(NO_CLIPPING_COPY)).toBeNull();
  });
});
