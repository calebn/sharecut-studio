import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { FrameAlerts } from "./FrameAlerts";
import {
  FRAME_ALERT_PRIORITY,
  useFrameAlert,
  useFrameAlertList,
} from "./useFrameAlert";

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

it("keeps the order of equal alerts when the earlier one re-renders", () => {
  const tree = (first: string) => (
    <FrameAlerts>
      <Raise priority={FRAME_ALERT_PRIORITY.failed} title={first} />
      <Raise priority={FRAME_ALERT_PRIORITY.failed} title="Newer failure" />
    </FrameAlerts>
  );
  const { rerender } = render(tree("Older failure"));
  rerender(tree("Older failure, updated"));
  expect(screen.getByText("Newer failure")).toBeVisible();
  expect(screen.queryByText("Older failure, updated")).toBeNull();
});

function RaiseList({ titles }: { titles: string[] }) {
  useFrameAlertList(
    titles.map((title) => ({ id: title, state: "needs-you", title })),
  );
  return null;
}

it("lists room alerts above job failures and drops the ones that go away", () => {
  const tree = (titles: string[]) => (
    <FrameAlerts>
      <Raise priority={FRAME_ALERT_PRIORITY.failed} title="Run failed" />
      <RaiseList titles={titles} />
    </FrameAlerts>
  );
  const { rerender } = render(tree(["Your mic stopped.", "You're muted."]));
  expect(screen.getByText("Your mic stopped.")).toBeVisible();
  expect(screen.getByRole("button", { name: "2 more alerts" })).toBeVisible();
  rerender(tree(["You're muted."]));
  expect(screen.getByText("You're muted.")).toBeVisible();
  expect(screen.queryByText("Your mic stopped.")).toBeNull();
  rerender(tree([]));
  expect(screen.getByText("Run failed")).toBeVisible();
});
