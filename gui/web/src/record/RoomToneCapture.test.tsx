import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { RoomToneCapture } from "./RoomToneCapture";
import {
  ROOM_TONE_CAPTURING_COPY,
  ROOM_TONE_NOT_READY_COPY,
  ROOM_TONE_PROMPT_COPY,
  ROOM_TONE_TOO_LOUD_COPY,
} from "./types";

describe("RoomToneCapture", () => {
  it("records, skips, and warns when too loud", async () => {
    const user = userEvent.setup();
    const onRecord = vi.fn();
    const onSkip = vi.fn();
    const onRetry = vi.fn();
    const { container, rerender } = render(
      <RoomToneCapture
        status="idle"
        error={null}
        micReady
        onRecord={onRecord}
        onSkip={onSkip}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(ROOM_TONE_PROMPT_COPY)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Record room tone" }));
    expect(onRecord).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(onSkip).toHaveBeenCalled();
    await expectNoA11yViolations(container);

    rerender(
      <RoomToneCapture
        status="too_loud"
        error={null}
        micReady
        onRecord={onRecord}
        onSkip={onSkip}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(ROOM_TONE_TOO_LOUD_COPY)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("announces capture progress and disables retry while capturing", async () => {
    const { container } = render(
      <RoomToneCapture
        status="capturing"
        error={null}
        micReady
        onRecord={() => undefined}
        onSkip={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(
      screen.getAllByText(ROOM_TONE_CAPTURING_COPY).length,
    ).toBeGreaterThan(0);
    expect(container.querySelector("section")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expectNoA11yViolations(container);
  });

  it("points describedby at the microphone reason when the mic is closed", async () => {
    const { container } = render(
      <RoomToneCapture
        status="idle"
        error={null}
        micReady={false}
        onRecord={() => undefined}
        onSkip={() => undefined}
        onRetry={() => undefined}
      />,
    );
    const record = screen.getByRole("button", { name: "Record room tone" });
    expect(record).toBeDisabled();
    const described = record.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(container.querySelector(`#${described}`)).toHaveTextContent(
      "Allow the microphone before recording room tone.",
    );
    await expectNoA11yViolations(container);
  });

  it("shows an error when the hook is not ready", async () => {
    const { container } = render(
      <RoomToneCapture
        status="idle"
        error={null}
        micReady
        captureReady={false}
        onRecord={() => undefined}
        onSkip={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(ROOM_TONE_NOT_READY_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Record room tone" }),
    ).toBeDisabled();
    await expectNoA11yViolations(container);
  });
});
