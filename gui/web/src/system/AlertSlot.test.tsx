import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AlertSlot, type AlertSlotItem } from "./AlertSlot";

const item = (
  id: string,
  extra: Partial<AlertSlotItem> = {},
): AlertSlotItem => ({
  id,
  state: "failed",
  title: `Title ${id}`,
  ...extra,
});

it("keeps an empty live region when there is nothing to say", () => {
  render(<AlertSlot alerts={[]} />);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

it("shows the first alert only and counts the rest behind +N", async () => {
  const user = userEvent.setup();
  render(<AlertSlot alerts={[item("a"), item("b"), item("c")]} />);
  expect(within(screen.getByRole("status")).getByText("Title a")).toBeVisible();
  expect(screen.queryByText("Title b")).toBeNull();
  const more = screen.getByRole("button", { name: "2 more alerts" });
  await user.click(more);
  expect(screen.getByText("Title b")).toBeVisible();
  expect(screen.getByText("Title c")).toBeVisible();
});

it("calls the top alert's action", async () => {
  const onAction = vi.fn();
  render(
    <AlertSlot
      alerts={[item("a", { action: { label: "Try again", onAction } })]}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(onAction).toHaveBeenCalledOnce();
});

it("keeps the live region quiet for text announced through the status line", () => {
  render(<AlertSlot alerts={[item("a", { announcedElsewhere: true })]} />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "off");
});
