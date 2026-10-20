import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { EmptyState } from "./EmptyState";

it("shows the message alone when there is no action", async () => {
  const { container } = render(<EmptyState>No comments yet.</EmptyState>);
  expect(screen.getByText("No comments yet.")).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  await expectNoA11yViolations(container);
});

it("offers the one control that leaves the dead end", async () => {
  const onClick = vi.fn();
  const { container } = render(
    <ul>
      <EmptyState as="li" action={{ label: "Show all comments", onClick }}>
        No comments in this filter.
      </EmptyState>
    </ul>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Show all comments" }),
  );
  expect(onClick).toHaveBeenCalledOnce();
  await expectNoA11yViolations(container);
});
