import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import type { FeedView } from "../../types/feedView";
import { FeedSection } from "./FeedSection";
import { PENDING } from "./feedFixture";

const view = {
  ...PENDING,
  findings: [
    {
      key: null,
      severity: "blocker",
      platform: "Apple",
      message: "Export the episode to supply the audio.",
      fix: { kind: "command", command: "export_episode" },
    },
    {
      key: null,
      severity: "warn",
      platform: "Apple",
      message: "Write the updated feed file.",
      fix: { kind: "command", command: "write_feed" },
    },
  ],
} satisfies FeedView;

const reason = "Wait for the settings to load.";
const readiness = () => screen.getByRole("button", { name: "Export episode" });
const check = () =>
  screen.getByRole("button", {
    name: "Export episode: Export the episode to supply the audio.",
  });

it("shows why both export fixes wait and leaves other Feed commands available", async () => {
  const onAction = vi.fn();
  const user = userEvent.setup();
  const props = { view, itemXml: "", onAction, onOpenSource: vi.fn() };
  const { container, rerender } = render(
    <FeedSection {...props} exportBlockedReason={reason} />,
  );
  await user.click(screen.getByText("Checks"));
  for (const button of [readiness(), check()]) {
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(reason);
    await user.click(button);
  }
  expect(screen.getByText(reason)).toBeVisible();
  expect(onAction).not.toHaveBeenCalled();
  await expectNoA11yViolations(container);

  await user.click(
    screen.getByRole("button", { name: /: Write the updated feed file\./ }),
  );
  expect(onAction).toHaveBeenCalledWith({
    kind: "command",
    command: "write_feed",
  });

  rerender(<FeedSection {...props} />);
  for (const button of [readiness(), check()]) {
    expect(button).toBeEnabled();
    await user.click(button);
  }
  expect(onAction.mock.calls).toEqual([
    [{ kind: "command", command: "write_feed" }],
    [{ kind: "command", command: "export_episode" }],
    [{ kind: "command", command: "export_episode" }],
  ]);
});

it("keeps the inaccessible readiness action hidden and the editor check access reason", async () => {
  const user = userEvent.setup();
  render(
    <FeedSection
      view={view}
      itemXml=""
      access="editor"
      onAction={vi.fn()}
      onOpenSource={vi.fn()}
      exportBlockedReason={reason}
    />,
  );
  expect(screen.queryByRole("button", { name: "Export episode" })).toBeNull();
  await user.click(screen.getByText("Checks"));
  expect(check()).toBeDisabled();
  expect(check()).toHaveAccessibleDescription("Only the host can change this.");
});
