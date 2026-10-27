import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PEOPLE } from "../../system/prepareFixtures";
import { expectNoA11yViolations } from "../../test/a11y";
import { SpeakerPopover, type SpeakerPopoverProps } from "./SpeakerPopover";

function setup(over: Partial<SpeakerPopoverProps> = {}) {
  const handlers = { onPick: vi.fn(), onRename: vi.fn(), onClose: vi.fn() };
  const view = render(
    <SpeakerPopover
      people={PEOPLE}
      currentId="anneke"
      {...handlers}
      {...over}
    />,
  );
  return { ...handlers, ...view };
}

describe("SpeakerPopover", () => {
  it("lists the people with a check on the turn's speaker and no Save button", async () => {
    const { container } = setup();
    expect(screen.getByRole("heading", { name: "Speaker" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /^Anneke/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: /save|apply/i })).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("moves the turn as soon as another person is picked", async () => {
    const user = userEvent.setup();
    const { onPick } = setup();
    await user.click(screen.getByRole("radio", { name: /^Maya/ }));
    expect(onPick.mock.calls).toEqual([["maya"]]);
  });

  it("renames on Enter and puts focus back on Fix text", async () => {
    const user = userEvent.setup();
    const { onRename } = setup();
    await user.click(screen.getByRole("button", { name: "Fix text for Joss" }));
    const field = screen.getByRole("textbox", { name: "Name for Joss" });
    expect(field).toHaveFocus();
    await user.keyboard("Joss Hart{Enter}");
    expect(onRename.mock.calls).toEqual([["joss", "Joss Hart"]]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Fix text for Joss" }),
    ).toHaveFocus();
  });

  it("puts the name back on Esc and renames nobody", async () => {
    const user = userEvent.setup();
    const { onRename, onClose } = setup({ initialRenamingId: "maya" });
    await user.keyboard("Someone else{Escape}");
    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Maya Okafor")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Fix text for Maya Okafor" }),
    ).toHaveFocus();
  });

  it("keeps the radio group usable while a name is open", () => {
    setup({ initialRenamingId: "maya" });
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(
      screen.getByRole("textbox", { name: "Name for Maya Okafor" }),
    ).toHaveFocus();
  });

  it("closes from its header", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
