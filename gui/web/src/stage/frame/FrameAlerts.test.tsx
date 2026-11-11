import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { FrameAlerts } from "./FrameAlerts";
import { FRAME_ALERT_PRIORITY, useFrameAlert } from "./useFrameAlert";

function Raise({ priority, title }: { priority: number; title: string }) {
  useFrameAlert(priority, { state: "failed", title });
  return null;
}

it("shows the most urgent alert in one slot and counts the others", () => {
  render(
    <FrameAlerts>
      <Raise priority={FRAME_ALERT_PRIORITY.failed + 1} title="Needs you" />
      <Raise priority={FRAME_ALERT_PRIORITY.failed} title="Run failed" />
    </FrameAlerts>,
  );
  expect(
    within(screen.getByRole("status")).getByText("Run failed"),
  ).toBeVisible();
  expect(screen.queryByText("Needs you")).toBeNull();
  expect(screen.getByRole("button", { name: "1 more alert" })).toBeVisible();
});

it("drops an alert when its component unmounts", () => {
  const { rerender } = render(
    <FrameAlerts>
      <Raise priority={FRAME_ALERT_PRIORITY.failed} title="Run failed" />
    </FrameAlerts>,
  );
  expect(screen.getByText("Run failed")).toBeVisible();
  rerender(<FrameAlerts>{null}</FrameAlerts>);
  expect(screen.queryByText("Run failed")).toBeNull();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

it("shows the newest of two alerts with the same priority", () => {
  render(
    <FrameAlerts>
      <Raise priority={FRAME_ALERT_PRIORITY.failed} title="First failure" />
      <Raise priority={FRAME_ALERT_PRIORITY.failed} title="Second failure" />
    </FrameAlerts>,
  );
  expect(screen.getByText("Second failure")).toBeVisible();
  expect(screen.queryByText("First failure")).toBeNull();
});
