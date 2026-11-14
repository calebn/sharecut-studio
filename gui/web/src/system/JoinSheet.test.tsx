import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSY_REASON } from "../ui/disabledReason";
import { JoinSheet, type JoinSheetProps } from "./JoinSheet";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const ROSA = { name: "Rosa Diaz", colorIndex: 4 };
const HERE: JoinSheetProps["here"] = [
  { person: MAYA, role: "host" },
  { person: ROSA, role: "producer" },
];

function Harness(props: Partial<JoinSheetProps>) {
  const [name, setName] = useState(props.name ?? "");
  return (
    <JoinSheet
      seat="guest"
      here={HERE}
      host="Maya Okafor"
      onJoin={vi.fn()}
      onDecline={vi.fn()}
      {...props}
      name={name}
      onNameChange={setName}
    />
  );
}

const READY = {
  name: "Jon",
  mic: { status: "ready", input: "MacBook Mic", level: 0.3 },
  headphones: true,
} as const;

const touchScreen = () =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(any-pointer: coarse)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));

afterEach(() => vi.unstubAllGlobals());

const primary = (name: string) => screen.getByRole("button", { name });

describe("JoinSheet guest", () => {
  it("titles the sheet by who is here and lists the rows", () => {
    render(<Harness />);
    expect(
      screen.getByRole("dialog", { name: "Maya and Rosa are here" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Your name" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Microphone")).toBeInTheDocument();
    expect(screen.getByText("Headphones")).toBeInTheDocument();
  });

  it("disables Join and record with the first unmet reason inline", () => {
    render(<Harness mic={{ status: "idle" }} name="Jon" />);
    const join = primary("Join and record");
    expect(join).toBeDisabled();
    expect(join).toHaveAccessibleDescription("Allow your microphone first");
    expect(screen.getByText("Allow your microphone first")).toBeVisible();
  });

  it("checks the name row off as you type and moves the reason on", async () => {
    render(<Harness />);
    expect(screen.getByText("Add your name first")).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your name" }),
      "Jon",
    );
    expect(screen.getByText("Allow your microphone first")).toBeInTheDocument();
  });

  it("enables and fires Join and record when every row is done", async () => {
    const onJoin = vi.fn();
    render(<Harness {...READY} onJoin={onJoin} />);
    await userEvent.click(primary("Join and record"));
    expect(onJoin).toHaveBeenCalledOnce();
  });

  it("joins on Enter in a ready name field", async () => {
    const onJoin = vi.fn();
    render(<Harness {...READY} onJoin={onJoin} />);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your name" }),
      "{Enter}",
    );
    expect(onJoin).toHaveBeenCalledOnce();
  });

  it("moves Enter on the name to the mic row when it is not done", async () => {
    const onJoin = vi.fn();
    render(<Harness name="Jon" mic={{ status: "idle" }} onJoin={onJoin} />);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your name" }),
      "{Enter}",
    );
    expect(onJoin).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Allow microphone" }),
    ).toHaveFocus();
  });

  it("moves Enter on the name to the mic row itself while the browser is prompting", async () => {
    const onJoin = vi.fn();
    render(
      <Harness name="Jon" mic={{ status: "prompting" }} onJoin={onJoin} />,
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your name" }),
      "{Enter}",
    );
    expect(onJoin).not.toHaveBeenCalled();
    expect(document.querySelector('[data-step="mic"]')).toHaveFocus();
  });

  it.each([
    ["idle", "Allow microphone", "allow"],
    ["denied", "How to allow the microphone", "how-to"],
    ["lost", "Retry microphone", "retry"],
  ] as const)(
    "the %s mic row offers one action",
    async (status, name, kind) => {
      const onMicAction = vi.fn();
      render(<Harness {...READY} mic={{ status }} onMicAction={onMicAction} />);
      await userEvent.click(screen.getByRole("button", { name }));
      expect(onMicAction).toHaveBeenCalledWith(kind);
    },
  );

  it("puts the mic action under its label", () => {
    render(<Harness {...READY} mic={{ status: "idle" }} />);
    const allow = screen.getByRole("button", { name: "Allow microphone" });
    expect(allow.closest('[data-step="mic"] .sys-join-control')).not.toBeNull();
  });

  it("toggles the headphones row", async () => {
    const onHeadphonesChange = vi.fn();
    render(
      <Harness
        {...READY}
        headphones={false}
        onHeadphonesChange={onHeadphonesChange}
      />,
    );
    const toggle = screen.getByRole("button", {
      name: "I'm wearing headphones",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(onHeadphonesChange).toHaveBeenCalledWith(true);
  });

  it("says too loud and low space in the mic row's status region", () => {
    render(
      <Harness
        {...READY}
        lowStorage
        mic={{ status: "ready", input: "Mic", level: 1, clipped: true }}
      />,
    );
    const rows = document.querySelector('[data-step="mic"]') as HTMLElement;
    const region = rows.querySelector(".sys-join-notes");
    expect(region).toHaveTextContent("Too loud. Move back a little.");
    expect(region).toHaveTextContent("Low space on this device.");
    expect(rows.querySelector(".sys-join-clip")).toHaveAttribute("data-lit");
  });

  it("keeps the clip tick dark without a clip", () => {
    render(<Harness {...READY} />);
    expect(document.querySelector(".sys-join-clip")).not.toHaveAttribute(
      "data-lit",
    );
  });

  it("shows the consent line and a Details disclosure with the listeners", async () => {
    render(<Harness {...READY} />);
    expect(
      screen.getByText(/recorded in full quality on this device/),
    ).toBeInTheDocument();
    const details = screen.getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Rosa is listening and won't be recorded"),
    ).toBeInTheDocument();
  });

  it("holds the primary in place with a busy state while joining", async () => {
    const onJoin = vi.fn();
    render(<Harness {...READY} joining onJoin={onJoin} />);
    const join = primary("Joining…");
    expect(join).toHaveAttribute("aria-disabled", "true");
    expect(join).toHaveAttribute("aria-busy", "true");
    await userEvent.click(join);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("names the row focus lands on for a touch screen", async () => {
    touchScreen();
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Your name" })).toHaveFocus(),
    );
  });

  it("holds Allow microphone busy while the browser asks", async () => {
    const onMicAction = vi.fn();
    render(
      <Harness
        name="Jon"
        mic={{ status: "prompting" }}
        onMicAction={onMicAction}
      />,
    );
    const allow = primary("Allow microphone");
    expect(allow).toHaveAttribute("aria-busy", "true");
    expect(allow).toHaveAttribute("aria-disabled", "true");
    expect(allow).not.toBeDisabled();
    expect(allow).toHaveAttribute("title", BUSY_REASON);
    await userEvent.click(allow);
    expect(onMicAction).not.toHaveBeenCalled();
  });

  it("keeps focus on the mic action when the prompt is denied", async () => {
    const { rerender } = render(
      <Harness name="Jon" mic={{ status: "idle" }} />,
    );
    await waitFor(() => expect(primary("Allow microphone")).toHaveFocus());
    rerender(<Harness name="Jon" mic={{ status: "prompting" }} />);
    expect(primary("Allow microphone")).toHaveFocus();
    expect(primary("Allow microphone")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    rerender(<Harness name="Jon" mic={{ status: "denied" }} />);
    expect(primary("How to allow the microphone")).toHaveFocus();
    expect(
      within(document.querySelector('[data-step="mic"]') as HTMLElement)
        .getAllByRole("status")
        .some((node) => node.textContent?.includes("Microphone blocked")),
    ).toBe(true);
  });

  it("keeps focus on the mic action when the microphone is lost", async () => {
    const { rerender } = render(
      <Harness name="Jon" mic={{ status: "idle" }} />,
    );
    await waitFor(() => expect(primary("Allow microphone")).toHaveFocus());
    rerender(<Harness name="Jon" mic={{ status: "prompting" }} />);
    rerender(
      <Harness name="Jon" mic={{ status: "lost", detail: "Unplugged" }} />,
    );
    expect(primary("Retry microphone")).toHaveFocus();
    expect(
      within(document.querySelector('[data-step="mic"]') as HTMLElement)
        .getAllByRole("status")
        .some((node) => node.textContent?.includes("isn't available")),
    ).toBe(true);
  });

  it("declines from Not now, Close and Escape", async () => {
    const onDecline = vi.fn();
    render(<Harness {...READY} onDecline={onDecline} />);
    await userEvent.click(primary("Not now"));
    await userEvent.click(primary("Close"));
    await userEvent.keyboard("{Escape}");
    expect(onDecline).toHaveBeenCalledTimes(3);
  });

  it("has one Close and no Sheet height, Collapse or Expand control", () => {
    render(<Harness {...READY} />);
    expect(screen.getAllByRole("button", { name: /^Close/ })).toHaveLength(1);
    expect(screen.queryByRole("slider", { name: "Sheet height" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^(Collapse|Expand)/ }),
    ).toBeNull();
  });

  it("does not decline on a press beside the sheet", async () => {
    const onDecline = vi.fn();
    render(<Harness {...READY} onDecline={onDecline} />);
    await userEvent.click(
      document.querySelector(".command-palette-scrim") as Element,
    );
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("sets the name field's keyboard hints", () => {
    const { rerender } = render(<Harness name="Jon" />);
    const field = screen.getByRole("textbox", { name: "Your name" });
    expect(field).toHaveAttribute("enterkeyhint", "next");
    expect(field).toHaveAttribute("autocapitalize", "words");
    expect(field).toHaveAttribute("autocorrect", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
    expect(field).toHaveAttribute("maxlength", "40");
    expect(field).toHaveAttribute("autocomplete", "name");
    rerender(<Harness {...READY} />);
    expect(screen.getByRole("textbox", { name: "Your name" })).toHaveAttribute(
      "enterkeyhint",
      "go",
    );
  });
});

describe("JoinSheet first focus", () => {
  it("opens on the name field, never on Close", async () => {
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Your name" })).toHaveFocus(),
    );
  });

  it("opens on the name row without focusing the field on a touch screen", async () => {
    touchScreen();
    render(<Harness />);
    await waitFor(() =>
      expect(document.querySelector('[data-step="name"]')).toHaveFocus(),
    );
    expect(
      screen.getByRole("textbox", { name: "Your name" }),
    ).not.toHaveFocus();
  });

  it("opens on Allow microphone when the name is already known", async () => {
    render(<Harness name="Jon" mic={{ status: "idle" }} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Allow microphone" }),
      ).toHaveFocus(),
    );
  });

  it("opens on Join and record when every row is done", async () => {
    render(<Harness {...READY} />);
    await waitFor(() => expect(primary("Join and record")).toHaveFocus());
  });

  it("moves focus from the waiting mic row to Join and record when the prompt resolves", async () => {
    const { rerender } = render(
      <Harness {...READY} mic={{ status: "prompting" }} />,
    );
    await waitFor(() =>
      expect(document.querySelector('[data-step="mic"]')).toHaveFocus(),
    );
    rerender(<Harness {...READY} />);
    await waitFor(() => expect(primary("Join and record")).toHaveFocus());
  });

  it("moves focus on when the storage row it waited on goes away", async () => {
    const { rerender } = render(
      <Harness {...READY} blocker={{ text: "Checking this device…" }} />,
    );
    await waitFor(() =>
      expect(document.querySelector('[data-step="storage"]')).toHaveFocus(),
    );
    rerender(<Harness {...READY} />);
    await waitFor(() => expect(primary("Join and record")).toHaveFocus());
  });

  it("leaves focus in the name field while the guest types", async () => {
    render(<Harness mic={{ status: "idle" }} />);
    const field = screen.getByRole("textbox", { name: "Your name" });
    await userEvent.type(field, "Jon");
    expect(field).toHaveFocus();
  });
});

describe("JoinSheet input and storage", () => {
  const DEVICES = [
    { id: "usb", label: "USB Condenser" },
    { id: "built-in", label: "MacBook Mic" },
  ];
  const withDevices = (extra = {}) => ({
    status: "ready" as const,
    input: "MacBook Mic",
    level: 0.3,
    devices: DEVICES,
    ...extra,
  });

  it("picks an input and reports its id", async () => {
    const onInputChange = vi.fn();
    render(
      <Harness
        {...READY}
        mic={withDevices({ inputId: "built-in" })}
        onInputChange={onInputChange}
      />,
    );
    const chip = screen.getByRole("button", { name: "Input: MacBook Mic" });
    expect(chip).toHaveAttribute("aria-haspopup", "menu");
    await userEvent.click(chip);
    const menu = screen.getByRole("menu", { name: "Input" });
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Default",
      "USB Condenser",
      "MacBook Mic",
    ]);
    expect(rows[2]).toHaveAttribute("aria-checked", "true");
    await userEvent.click(rows[1]);
    expect(onInputChange).toHaveBeenCalledWith("usb");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Input:/ }));
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: "Default" }),
    );
    expect(onInputChange).toHaveBeenLastCalledWith("");
  });

  it("locks the picker while a take runs and says why", () => {
    render(<Harness {...READY} mic={withDevices({ inputLocked: true })} />);
    expect(screen.getByRole("button", { name: /^Input:/ })).toBeDisabled();
    expect(
      screen.getByText("Can't change while a take is running."),
    ).toBeVisible();
  });

  it("shows no picker without devices or before the mic is ready", () => {
    const { rerender } = render(<Harness {...READY} />);
    expect(screen.queryByRole("button", { name: /^Input:/ })).toBeNull();
    rerender(<Harness {...READY} mic={{ status: "idle" }} />);
    expect(screen.queryByRole("button", { name: /^Input:/ })).toBeNull();
  });

  it("names the storage blocker first and offers its action", async () => {
    const onBlockerAction = vi.fn();
    render(
      <Harness
        {...READY}
        blocker={{
          text: "This browser can't save a recording here.",
          action: { label: "Retry storage check" },
        }}
        onBlockerAction={onBlockerAction}
      />,
    );
    expect(primary("Join and record")).toBeDisabled();
    expect(primary("Join and record")).toHaveAccessibleDescription(
      "Fix storage first",
    );
    const rows = [...document.querySelectorAll("[data-step]")];
    expect(rows[0]).toHaveAttribute("data-step", "storage");
    await userEvent.click(
      screen.getByRole("button", { name: "Retry storage check" }),
    );
    expect(onBlockerAction).toHaveBeenCalledOnce();
  });

  it("waits on a storage check that has no action yet", () => {
    render(<Harness {...READY} blocker={{ text: "Checking this device…" }} />);
    expect(screen.getByText("Wait for the storage check first")).toBeVisible();
    expect(screen.queryByRole("button", { name: /storage/i })).toBeNull();
  });

  it("shows the lost microphone's detail and the caller's notes", () => {
    render(
      <Harness
        {...READY}
        mic={{ status: "lost", detail: "Microphone disconnected." }}
        micNotes={["Your saved microphone isn't available."]}
      />,
    );
    expect(screen.getByText("Microphone disconnected.")).toBeVisible();
    const region = document.querySelector('[data-step="mic"] .sys-join-notes');
    expect(region).toHaveTextContent("Your saved microphone isn't available.");
  });
});

describe("JoinSheet producer", () => {
  it("has one name row, the listen line and Join to listen", async () => {
    const onJoin = vi.fn();
    render(<Harness seat="producer" name="Rosa" onJoin={onJoin} />);
    expect(
      screen.getByText("You'll listen and take notes. You won't be recorded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Microphone")).toBeNull();
    expect(screen.queryByText("Headphones")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    await userEvent.click(primary("Join to listen"));
    expect(onJoin).toHaveBeenCalledOnce();
  });

  it("waits for a name", () => {
    render(<Harness seat="producer" />);
    expect(primary("Join to listen")).toBeDisabled();
    expect(screen.getByText("Add your name first")).toBeVisible();
  });
});
