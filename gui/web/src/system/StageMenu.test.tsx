import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { StageMenu } from "./StageMenu";

describe("StageMenu", () => {
  it("lists the tab bar's stages in order and names the current one", async () => {
    const user = userEvent.setup();
    render(<StageMenu active="edit" onSelect={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Stage menu, Edit" }));
    const menu = screen.getByRole("menu", { name: "Stages" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Record",
      "Prepare",
      "Edit (current)",
      "Review",
      "Deliver",
    ]);
    await expectNoA11yViolations(menu);
  });

  it("shows only the stages a role has, with their badges", async () => {
    const user = userEvent.setup();
    render(
      <StageMenu
        active="review"
        stages={["edit", "review"]}
        badges={{ review: { kind: "needs-you", count: 2 } }}
        onSelect={() => undefined}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Stage menu, Review" }),
    );
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveAccessibleName(/Review.*2/);
  });

  it("selects a stage and closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<StageMenu active="edit" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Stage menu, Edit" }));
    await user.click(screen.getByRole("menuitem", { name: "Deliver" }));
    expect(onSelect).toHaveBeenCalledWith("deliver");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("carries the Record badge on the Record row", async () => {
    const user = userEvent.setup();
    render(
      <StageMenu
        active="edit"
        record={{ kind: "waiting", count: 3 }}
        onSelect={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Stage menu, Edit" }));
    expect(
      screen.getByRole("menuitem", { name: "Record 3 waiting" }),
    ).toBeInTheDocument();
  });
});
