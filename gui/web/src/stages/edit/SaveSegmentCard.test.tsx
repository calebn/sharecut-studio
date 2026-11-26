import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { ApiError } from "../../utils/apiError";
import { SaveSegmentCard, type SaveSegmentCardProps } from "./SaveSegmentCard";

afterEach(() => vi.unstubAllGlobals());

const crampedScreen = () => vi.stubGlobal("innerHeight", 300);

type Handlers = Pick<SaveSegmentCardProps, "onSave" | "onClose">;

function Anchored({ handlers }: { handlers: Handlers }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={anchor} type="button">
        Selected clips
      </button>
      <SaveSegmentCard
        summary="3 clips, 0:22"
        defaultKind="intro"
        {...handlers}
        onClose={() => {
          handlers.onClose();
          setOpen(false);
        }}
        anchorRef={anchor}
        open={open}
      />
    </>
  );
}

function Bottom({ handlers }: { handlers: Handlers }) {
  return (
    <SaveSegmentCard
      summary="1 clip, 0:05"
      defaultKind="other"
      {...handlers}
      form="bottom"
      open
    />
  );
}

const handlersOf = (
  onSave: Handlers["onSave"] = vi.fn().mockResolvedValue(undefined),
): Handlers => ({ onSave, onClose: vi.fn() });

describe("SaveSegmentCard anchored", () => {
  it("focuses the name, shows the summary and the guessed kind", async () => {
    const { baseElement } = render(<Anchored handlers={handlersOf()} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.getByText("3 clips, 0:22")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Kind" })).toHaveValue("intro");
    expect(
      [
        ...screen
          .getByRole("combobox", { name: "Kind" })
          .querySelectorAll("option"),
      ].map((option) => option.value),
    ).toEqual(["intro", "outro", "sponsor", "sting", "other"]);
    await expectNoA11yViolations(baseElement);
  });

  it("refuses an empty name without saving", async () => {
    const handlers = handlersOf();
    render(<Anchored handlers={handlers} />);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a name for the segment.",
    );
    expect(handlers.onSave).not.toHaveBeenCalled();
  });

  it("saves the trimmed name and the chosen kind, then closes", async () => {
    const handlers = handlersOf();
    render(<Anchored handlers={handlers} />);
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name" }),
      "  Cold open  ",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Kind" }),
      "sting",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(handlers.onSave).toHaveBeenCalledWith({
      name: "Cold open",
      kind: "sting",
    });
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
  });

  it("ignores a second press while saving", async () => {
    let finish!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handlers = handlersOf(onSave);
    render(<Anchored handlers={handlers} />);
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name" }),
      "Intro{Enter}",
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.click(save);
    await userEvent.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
  });

  it("stays open on Escape and Cancel while saving, so a failure is not lost", async () => {
    let fail!: (error: unknown) => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const handlers = handlersOf(onSave);
    render(<Anchored handlers={handlers} />);
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name" }),
      "Intro{Enter}",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving to your library.",
    );
    await userEvent.keyboard("{Escape}");
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fail(new Error("offline"));
    expect(
      await screen.findByText("That did not save. Try again."),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["segment_clip_too_short", /too short/],
    ["segment_render_unsupported", /muted speakers/],
    ["segment_busy", /busy/],
    ["segment_write_failed", /could not be written/],
    ["segment_invalid", /cannot be saved/],
  ])("explains %s inline and stays open", async (code, message) => {
    const handlers = handlersOf(
      vi.fn().mockRejectedValue(new ApiError("raw server text", code, 400)),
    );
    const { baseElement } = render(<Anchored handlers={handlers} />);
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name" }),
      "Intro{Enter}",
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent("raw server text");
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await expectNoA11yViolations(baseElement);
  });

  it("says a failure it does not know in a plain sentence", async () => {
    render(
      <Anchored
        handlers={handlersOf(vi.fn().mockRejectedValue(new Error("boom")))}
      />,
    );
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name" }),
      "Intro{Enter}",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That did not save. Try again.",
    );
  });

  it("keeps Cancel and Save inside the form on the anchored card", async () => {
    render(<Anchored handlers={handlersOf()} />);
    const form = (await screen.findByRole("dialog")).querySelector("form");
    expect(form).toContainElement(screen.getByRole("button", { name: "Save" }));
    expect(form).toContainElement(
      screen.getByRole("button", { name: "Cancel" }),
    );
  });

  it("closes on Cancel without saving", async () => {
    const handlers = handlersOf();
    render(<Anchored handlers={handlers} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onSave).not.toHaveBeenCalled();
  });
});

describe("SaveSegmentCard bottom", () => {
  it("is one sheet with the same fields and a labelled dialog", async () => {
    const { baseElement } = render(<Bottom handlers={handlersOf()} />);
    const dialog = await screen.findByRole("dialog", {
      name: "Save as segment",
    });
    expect(dialog).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus(),
    );
    expect(screen.getByRole("combobox", { name: "Kind" })).toHaveValue("other");
    expect(screen.getByText("1 clip, 0:05")).toBeVisible();
    await expectNoA11yViolations(baseElement);
  });

  it("saves from the sheet", async () => {
    const handlers = handlersOf();
    render(<Bottom handlers={handlers} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveFocus());
    await userEvent.type(name, "Sponsor read");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(handlers.onSave).toHaveBeenCalledWith({
      name: "Sponsor read",
      kind: "other",
    });
  });

  it("pins Cancel and Save in the sheet footer, outside the form", async () => {
    render(<Bottom handlers={handlersOf()} />);
    const dialog = await screen.findByRole("dialog", {
      name: "Save as segment",
    });
    const footer = dialog.querySelector<HTMLElement>(".sys-sheet-footer");
    const form = dialog.querySelector("form");
    expect(footer).not.toBeNull();
    for (const name of ["Cancel", "Save"]) {
      const button = screen.getByRole("button", { name });
      expect(footer).toContainElement(button);
      expect(form).not.toContainElement(button);
    }
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "form",
      form?.id,
    );
  });

  it("keeps the actions in the form on a cramped screen", async () => {
    crampedScreen();
    render(<Bottom handlers={handlersOf()} />);
    const dialog = await screen.findByRole("dialog", {
      name: "Save as segment",
    });
    expect(dialog.querySelector(".sys-sheet-footer")).toBeNull();
    expect(dialog.querySelector("form")).toContainElement(
      screen.getByRole("button", { name: "Save" }),
    );
    expect(dialog).toHaveClass("bottom-sheet--full");
  });

  it("saves on Enter in the Name field", async () => {
    const handlers = handlersOf();
    render(<Bottom handlers={handlers} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveFocus());
    await userEvent.keyboard("Sponsor read");
    expect(name).toHaveValue("Sponsor read");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(handlers.onSave).toHaveBeenCalledWith({
        name: "Sponsor read",
        kind: "other",
      }),
    );
  });

  it("keeps Cancel off while saving", async () => {
    const onSave = vi.fn(() => new Promise<void>(() => {}));
    render(<Bottom handlers={handlersOf(onSave)} />);
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name" }),
      "Sponsor read",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel" }),
      ).toHaveAccessibleDescription("Saving to your library."),
    );
  });
});

describe("SaveSegmentCard kind default", () => {
  const props = handlersOf();

  it("follows the guessed kind until the user picks one", async () => {
    const { rerender } = render(
      <SaveSegmentCard
        summary="1 clip, 0:05"
        defaultKind="intro"
        {...props}
        form="bottom"
        open
      />,
    );
    const kind = await screen.findByRole("combobox", { name: "Kind" });
    rerender(
      <SaveSegmentCard
        summary="1 clip, 0:05"
        defaultKind="outro"
        {...props}
        form="bottom"
        open
      />,
    );
    expect(kind).toHaveValue("outro");
    await userEvent.selectOptions(kind, "sting");
    rerender(
      <SaveSegmentCard
        summary="1 clip, 0:05"
        defaultKind="other"
        {...props}
        form="bottom"
        open
      />,
    );
    expect(kind).toHaveValue("sting");
  });
});

describe("SaveSegmentCard across the phone and desktop forms", () => {
  function Switching({ handlers }: { handlers: Handlers }) {
    const anchor = useRef<HTMLButtonElement>(null);
    const [bottom, setBottom] = useState(false);
    const common = {
      summary: "3 clips, 0:22",
      defaultKind: "intro" as const,
      ...handlers,
    };
    return (
      <>
        <button ref={anchor} type="button" onClick={() => setBottom(!bottom)}>
          Switch form
        </button>
        {bottom ? (
          <SaveSegmentCard {...common} form="bottom" open />
        ) : (
          <SaveSegmentCard {...common} anchorRef={anchor} />
        )}
      </>
    );
  }

  it("keeps the name, the kind and the save in flight when the form changes", async () => {
    let finish!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handlers = handlersOf(onSave);
    render(<Switching handlers={handlers} />);
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Name" }),
      "Cold open",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Kind" }),
      "sting",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Switch form", hidden: true }),
    );
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(
      "Cold open",
    );
    expect(screen.getByRole("combobox", { name: "Kind" })).toHaveValue("sting");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving to your library.",
    );
    await userEvent.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
  });
});
