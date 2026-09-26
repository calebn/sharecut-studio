import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { MicMeter } from "./MicMeter";
import { HEADROOM_HINT_COPY, METER_CLIPPED_COPY } from "./types";

const meter = vi.hoisted(() => ({
  levelDb: -20,
  peakHoldDb: -15,
  clipped: false,
  suspended: false,
  clearClip: vi.fn(),
  latchClip: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("./useInputPeakDb", () => ({ useInputPeakDb: () => meter }));

const stream = {} as MediaStream;

describe("MicMeter", () => {
  beforeEach(() => {
    meter.clipped = false;
    meter.suspended = false;
    meter.clearClip.mockReset();
    meter.resume.mockReset();
  });

  it("renders nothing without a stream", () => {
    const { container } = render(<MicMeter stream={null} label="Level" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the meter and headroom hint", async () => {
    const { container } = render(<MicMeter stream={stream} label="Level" />);
    expect(screen.getByRole("meter", { name: "Level" })).toBeInTheDocument();
    expect(screen.getByText(HEADROOM_HINT_COPY)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("offers to clear a clip", async () => {
    meter.clipped = true;
    render(<MicMeter stream={stream} label="Level" />);
    expect(screen.getByText(METER_CLIPPED_COPY)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Clear clip light" }),
    );
    expect(meter.clearClip).toHaveBeenCalledOnce();
  });

  it("offers to start a suspended meter", async () => {
    meter.suspended = true;
    render(<MicMeter stream={stream} label="Level" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Start level meter" }),
    );
    expect(meter.resume).toHaveBeenCalledOnce();
  });
});
