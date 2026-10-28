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
    await userEvent.type(screen.getByLabelText("Your name"), "{Enter}");
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
