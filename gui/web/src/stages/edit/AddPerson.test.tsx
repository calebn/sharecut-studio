import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddPerson } from "./AddPerson";

function setup(onAdd = vi.fn()) {
  render(
    <AddPerson
      label="Add person"
      fieldLabel="Name of the new person"
      validate={(text) => (text === "" ? "Enter a name." : undefined)}
      onAdd={onAdd}
    />,
  );
  return onAdd;
}

const field = () =>
  screen.getByRole("textbox", { name: "Name of the new person" });

describe("AddPerson", () => {
  it("hands the typed name to onAdd on Enter and returns focus to the button", async () => {
    const user = userEvent.setup();
    const onAdd = setup();
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(field(), "Priya{Enter}");
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("Priya");
    expect(screen.getByRole("button", { name: "Add person" })).toHaveFocus();
  });

  it("shows the validation message for an empty name and sends nothing", async () => {
    const user = userEvent.setup();
    const onAdd = setup();
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(field(), "{Enter}");
    expect(screen.getByText("Enter a name.")).toBeVisible();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("keeps the field open with the reason when onAdd refuses", async () => {
    const user = userEvent.setup();
    setup(vi.fn(async () => "Taken."));
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(field(), "Mira{Enter}");
    expect(await screen.findByText("Taken.")).toBeVisible();
    expect(field()).toHaveValue("Mira");
  });

  it("closes on Escape without adding and returns focus to the button", async () => {
    const user = userEvent.setup();
    const onAdd = setup();
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(field(), "Mir{Escape}");
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add person" })).toHaveFocus();
  });
});
