import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, type Mock, vi } from "vitest";
import { PEOPLE } from "../../system/prepareFixtures";
import { expectNoA11yViolations } from "../../test/a11y";
import { overlayOpen } from "../../ui/modalGate";
import type { FixTextAnswer } from "./FixTextField";
import { SpeakerPopover, type SpeakerPopoverProps } from "./SpeakerPopover";

type Handlers = {
  onPick: Mock<(id: string) => FixTextAnswer>;
  onRename: Mock<(id: string, name: string) => FixTextAnswer>;
  onAddSpeaker: Mock<(name: string) => FixTextAnswer>;
  onClose: Mock<() => void>;
};

function Host({
  handlers,
  ...over
}: { handlers: Handlers } & Partial<SpeakerPopoverProps>) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={anchor} type="button">
        Anneke, change speaker
      </button>
      <SpeakerPopover
        people={PEOPLE}
        currentId="anneke"
        {...handlers}
        {...(over as object)}
        form="anchored"
        anchorRef={anchor}
        open={open}
        onClose={() => {
          handlers.onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

function setup(over: Partial<SpeakerPopoverProps> = {}) {
  const handlers: Handlers = {
    onPick: vi.fn(),
    onRename: vi.fn(),
    onAddSpeaker: vi.fn(),
    onClose: vi.fn(),
  };
  const view = render(<Host handlers={handlers} {...over} />);
  return { ...handlers, ...view };
}

/** The dialog's own first-frame focus has landed, so it cannot pull focus off a field opened next. */
const opened = async () => {
  await waitFor(() => expect(radio(/^Anneke/)).toHaveFocus());
  await act(() => new Promise<void>((done) => setTimeout(done, 60)));
};
const nameField = (name: string) =>
  screen.getByRole("textbox", { name: `Name for ${name}` });
const radio = (name: RegExp) => screen.getByRole("radio", { name });
const fixButton = (name: string) =>
  screen.getByRole("button", { name: `Fix text, rename ${name} everywhere` });

describe("SpeakerPopover", () => {
  it("is a labelled dialog with a check on the turn's speaker and no Save button", async () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Speaker" })).toBeVisible();
    expect(radio(/^Anneke/)).toBeChecked();
    expect(screen.queryByRole("button", { name: /save|apply/i })).toBeNull();
    await expectNoA11yViolations(document.body);
  });

  it("takes focus on the current speaker when it opens and joins the overlay stack", async () => {
    setup();
    await waitFor(() => expect(radio(/^Anneke/)).toHaveFocus());
    expect(overlayOpen()).toBe(true);
  });

  it("moves the focus ring with the arrows and picks nobody", async () => {
    const user = userEvent.setup();
    const { onPick, onClose } = setup();
    await waitFor(() => expect(radio(/^Anneke/)).toHaveFocus());
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(radio(/^Maya/)).toHaveFocus();
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(radio(/^Anneke/)).toBeChecked();
  });

  it("moves the turn on click, Space or Enter, and closes", async () => {
    for (const press of ["click", " ", "{Enter}"]) {
      const user = userEvent.setup();
      const { onPick, onClose, unmount } = setup();
      await waitFor(() => expect(radio(/^Anneke/)).toHaveFocus());
      if (press === "click") {
        await user.click(radio(/^Maya/));
      } else {
        await user.keyboard(`{ArrowDown}{ArrowDown}${press}`);
      }
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(onPick.mock.calls).toEqual([["maya"]]);
      unmount();
    }
  });

  it("closes without a move when the current speaker is picked again", async () => {
    const user = userEvent.setup();
    const { onPick, onClose } = setup();
    await user.click(radio(/^Anneke/));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("stays open with the reason when the move is refused", async () => {
    const user = userEvent.setup();
    const { onClose, onPick } = setup();
    onPick.mockResolvedValue("The transcript changed. Try again.");
    await user.click(radio(/^Maya/));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The transcript changed. Try again.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Esc and puts focus back on the margin name", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await waitFor(() => expect(radio(/^Anneke/)).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Anneke, change speaker" }),
    ).toHaveFocus();
    expect(overlayOpen()).toBe(false);
  });

  it("closes from its header", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a press outside", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SpeakerPopover rename", () => {
  it("names the pencil for what it does, everywhere", () => {
    setup();
    expect(fixButton("Joss")).toHaveTextContent("Fix text");
  });

  it("applies on Enter, once, and puts focus back on Fix text", async () => {
    const user = userEvent.setup();
    const { onRename } = setup();
    await user.click(fixButton("Joss"));
    expect(
      screen.getByRole("textbox", { name: "Name for Joss" }),
    ).toHaveFocus();
    await user.keyboard("Joss Hart{Enter}");
    expect(onRename.mock.calls).toEqual([["joss", "Joss Hart"]]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(fixButton("Joss")).toHaveFocus();
  });

  it("puts the name back on Esc, renames nobody and leaves the popover open", async () => {
    const user = userEvent.setup();
    const { onRename, onClose } = setup({ initialRenamingId: "maya" });
    await waitFor(() => expect(nameField("Maya Okafor")).toHaveFocus());
    await user.keyboard("Someone else{Escape}");
    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Maya Okafor")).toBeVisible();
    expect(fixButton("Maya Okafor")).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Speaker" })).toBeVisible();
  });

  it("does not apply a half-typed name when focus leaves the field", async () => {
    const user = userEvent.setup();
    const { onRename } = setup({ initialRenamingId: "maya" });
    await waitFor(() => expect(nameField("Maya Okafor")).toHaveFocus());
    await user.keyboard("Someone else");
    await user.click(radio(/^Joss/));
    expect(onRename).not.toHaveBeenCalled();
  });

  it("refuses an empty name and a name another speaker has, keeping the field open", async () => {
    const user = userEvent.setup();
    const { onRename } = setup({ initialRenamingId: "maya" });
    await waitFor(() => expect(nameField("Maya Okafor")).toHaveFocus());
    await user.keyboard("{Backspace}{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a speaker name.",
    );
    await user.keyboard("joss{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Another speaker already has that name.",
    );
    expect(onRename).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Name for Maya Okafor" }),
    ).toHaveFocus();
    await user.keyboard(
      "{Backspace}{Backspace}{Backspace}{Backspace}Josie{Enter}",
    );
    expect(onRename.mock.calls).toEqual([["maya", "Josie"]]);
  });

  it("keeps the field open with the reason when the host refuses the rename", async () => {
    const user = userEvent.setup();
    const { onRename } = setup({ initialRenamingId: "maya" });
    onRename.mockResolvedValue("Offline.");
    await waitFor(() => expect(nameField("Maya Okafor")).toHaveFocus());
    await user.keyboard("Maya O{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline.");
    expect(
      screen.getByRole("textbox", { name: "Name for Maya Okafor" }),
    ).toHaveValue("Maya O");
  });

  it("keeps the radio group usable while a name is open", async () => {
    setup({ initialRenamingId: "maya" });
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    await waitFor(() => expect(nameField("Maya Okafor")).toHaveFocus());
  });
});

describe("SpeakerPopover new speaker", () => {
  const add = async (user: ReturnType<typeof userEvent.setup>) => {
    await opened();
    await user.click(screen.getByRole("button", { name: "Add speaker" }));
  };

  it("offers Add speaker only when the host can add one", () => {
    const { unmount } = setup();
    expect(screen.getByRole("button", { name: "Add speaker" })).toBeVisible();
    unmount();
    render(
      <SpeakerPopover
        people={PEOPLE}
        currentId="anneke"
        form="bottom"
        open
        onPick={vi.fn()}
        onRename={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add speaker" })).toBeNull();
  });

  it("takes a free-text name on Enter, moves the turn to it and closes", async () => {
    const user = userEvent.setup();
    const { onAddSpeaker, onClose } = setup();
    await add(user);
    expect(
      screen.getByRole("textbox", { name: "Name of the new speaker" }),
    ).toHaveFocus();
    await user.keyboard("Priya Shah{Enter}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onAddSpeaker.mock.calls).toEqual([["Priya Shah"]]);
  });

  it("refuses an empty name and a duplicate, case aside", async () => {
    const user = userEvent.setup();
    const { onAddSpeaker } = setup();
    await add(user);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a speaker name.",
    );
    await user.keyboard("MAYA OKAFOR{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Another speaker already has that name.",
    );
    expect(onAddSpeaker).not.toHaveBeenCalled();
  });

  it("cancels on Esc and puts focus back on Add speaker", async () => {
    const user = userEvent.setup();
    const { onAddSpeaker, onClose } = setup();
    await add(user);
    await user.keyboard("Priya{Escape}");
    expect(onAddSpeaker).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add speaker" })).toHaveFocus();
  });
});
