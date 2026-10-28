import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
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

const primary = (name: string) => screen.getByRole("button", { name });

describe("JoinSheet guest", () => {
  it("titles the sheet by who is here and lists the rows", () => {
    render(<Harness />);
    expect(
      screen.getByRole("dialog", { name: "Maya and Rosa are here" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Your name")).toBeInTheDocument();
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
    await userEvent.type(screen.getByLabelText("Your name"), "Jon");
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
    const field = screen.getByLabelText("Your name");
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.type(field, "{Enter}");
    expect(onJoin).toHaveBeenCalledOnce();
  });

  it("moves Enter on the name to the mic row when it is not done", async () => {
    const onJoin = vi.fn();
    render(<Harness name="Jon" mic={{ status: "idle" }} onJoin={onJoin} />);
    const field = screen.getByLabelText("Your name");
    // The dialog takes its initial focus on the next frame; wait for it.
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.type(field, "{Enter}");
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
    const field = screen.getByLabelText("Your name");
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.type(field, "{Enter}");
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
    const region = within(rows).getByRole("status");
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

  it("holds the primary in place with a busy state while joining", () => {
    render(<Harness {...READY} joining />);
    const join = primary("Joining…");
    expect(join).toBeDisabled();
    expect(join).toHaveAttribute("aria-busy", "true");
  });

  it("declines from Not now and from Close", async () => {
    const onDecline = vi.fn();
    render(<Harness {...READY} onDecline={onDecline} />);
    await userEvent.click(primary("Not now"));
    await userEvent.click(primary("Close"));
    expect(onDecline).toHaveBeenCalledTimes(2);
  });
});

describe("JoinSheet input, storage and rejoin", () => {
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
    const picker = screen.getByRole("combobox", { name: "Input" });
    expect(picker).toHaveValue("built-in");
    await userEvent.selectOptions(picker, "usb");
    expect(onInputChange).toHaveBeenCalledWith("usb");
    await userEvent.selectOptions(picker, "Default");
    expect(onInputChange).toHaveBeenLastCalledWith("");
  });

  it("locks the picker while a take runs and says why", () => {
    render(<Harness {...READY} mic={withDevices({ inputLocked: true })} />);
    expect(screen.getByRole("combobox", { name: "Input" })).toBeDisabled();
    expect(
      screen.getByText("Can't change while a take is running."),
    ).toBeVisible();
  });

  it("shows no picker without devices or before the mic is ready", () => {
    const { rerender } = render(<Harness {...READY} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    rerender(<Harness {...READY} mic={{ status: "idle" }} />);
    expect(screen.queryByRole("combobox")).toBeNull();
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
    const region = within(
      document.querySelector('[data-step="mic"]') as HTMLElement,
    ).getByRole("status");
    expect(region).toHaveTextContent("Your saved microphone isn't available.");
  });

  it("opens on the primary when rejoining, and on the name otherwise", async () => {
    const { unmount } = render(<Harness {...READY} rejoin />);
    await waitFor(() => expect(primary("Join and record")).toHaveFocus());
    unmount();
    render(<Harness {...READY} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Your name")).toHaveFocus(),
    );
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

describe("JoinSheet phone", () => {
  it("is a bottom sheet titled by who is here", () => {
    render(<Harness {...READY} viewerWidth="phone" />);
    expect(
      screen.getByRole("dialog", { name: "Maya and Rosa are here" }),
    ).toBeInTheDocument();
    expect(document.querySelector(".sys-sheet-bottom")).not.toBeNull();
  });
});
