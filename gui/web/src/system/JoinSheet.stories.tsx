import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { useArgState } from "../test/storyDialog";
import { JoinSheet, type JoinSheetProps } from "./JoinSheet";
import { RoomView } from "./RoomView";
import type { RoomPhase } from "./roomPhase";
import type { RoomPerson } from "./roomViewModel";

// Fixtures for every story below. Stubbed state only: nothing here is wired.
const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const ANNEKE = { name: "Anneke de Vries", colorIndex: 1 };
const ROSA = { name: "Rosa Diaz", colorIndex: 2 };

const HOST: RoomPerson = {
  role: "host",
  person: MAYA,
  presence: "live",
  connection: "good",
  level: 0.4,
};
const ANNEKE_GUEST: RoomPerson = {
  role: "guest",
  person: ANNEKE,
  presence: "live",
  connection: "good",
  level: 0.1,
};
const ROSA_PRODUCER: RoomPerson = {
  role: "producer",
  person: ROSA,
  presence: "live",
};
const IN_ROOM = [HOST, ANNEKE_GUEST, ROSA_PRODUCER];

const WAITING: RoomPhase = { kind: "waiting", host: "Maya" };
const LIVE: RoomPhase = { kind: "live", take: 1, clockSec: 252 };

type StoryArgs = JoinSheetProps & { phase: RoomPhase };

const MIC_READY = {
  status: "ready",
  input: "MacBook Pro Microphone",
  level: 0.35,
} as const;

/** The room the sheet opens over: the people already here, no seat of the viewer's own. */
function Join({ phase, ...args }: StoryArgs) {
  const [name, setName] = useArgState(args.name);
  const [headphones, setHeadphones] = useArgState(args.headphones ?? false);
  return (
    <div style={{ blockSize: "44rem", inlineSize: "100%" }}>
      <RoomView
        seat={args.seat}
        title="Episode 14: the one about the mic"
        people={IN_ROOM}
        phase={phase}
        viewerWidth={args.viewerWidth === "phone" ? "phone" : "desktop"}
        notes={[]}
        selfName=""
        onSendNote={fn()}
      />
      <JoinSheet
        {...args}
        name={name}
        onNameChange={setName}
        headphones={headphones}
        onHeadphonesChange={setHeadphones}
      />
    </div>
  );
}

const meta: Meta<StoryArgs> = {
  title: "Stages/Record/JoinSheet",
  component: JoinSheet,
  tags: ["autodocs"],
  render: (args) => <Join {...args} />,
  args: {
    seat: "guest",
    viewerWidth: "desktop",
    here: IN_ROOM.map(({ person, role }) => ({ person, role })),
    host: "Maya Okafor",
    name: "Jon",
    mic: { status: "idle" },
    headphones: false,
    phase: WAITING,
    onNameChange: fn(),
    onHeadphonesChange: fn(),
    onMicAction: fn(),
    onJoin: fn(),
    onDecline: fn(),
  },
  parameters: {
    ...isolatedStoryParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "The pre-join sheet over a live room: the title and a row of avatars say who is here, then rows that check themselves off (name, microphone, headphones, each a Status row), the consent line with a Details disclosure, one primary and Not now. The primary stays disabled and names the first row still to do. A producer sees one name row, the headphone glyph and \"You'll listen and take notes. You won't be recorded.\" with Join to listen. Desktop is a centred card 420 wide, 96 from the top, with the room visible around it; the phone is a bottom Sheet at its large detent. Presentational: the caller owns the name, the microphone and the join itself, and Not now, Escape and Close all decline.\n\n**Motion.** None yet. Later: a row's glyph turns into its check with `--motion-state`, the meter follows the live level, and the clip tick fades out after 2 s.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<StoryArgs>;

/** True once the element and every ancestor are fully opaque. */
const opaque = (element: Element | null): boolean => {
  for (let node = element; node; node = node.parentElement) {
    if (Number(getComputedStyle(node).opacity || 1) < 1) return false;
  }
  return true;
};

/**
 * The open sheet, once its ~150 ms fade-in has settled: toBeVisible reads
 * opacity, which jsdom never animates but a real browser does.
 */
const sheet = async () => {
  const dialog = await within(document.body).findByRole("dialog", {
    name: "Maya, Anneke and Rosa are here",
  });
  // The fade is on the panel inside the dialog root, so check from there up.
  const panel = dialog.querySelector(".sys-join-sheet") ?? dialog;
  await waitFor(() => expect(opaque(panel)).toBe(true));
  return within(dialog);
};

const rowState = (step: string) =>
  document
    .querySelector(`[data-step="${step}"] .sys-status`)
    ?.getAttribute("data-state");

export const GuestPreMic: Story = {
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(
      dialog.getByRole("button", { name: "Join and record" }),
    ).toBeDisabled();
    await expect(dialog.getByText("Allow your microphone first")).toBeVisible();
    await expect(rowState("name")).toBe("done");
    await expect(rowState("mic")).toBe("queued");
    await expect(
      dialog.getByRole("button", { name: "Allow microphone" }),
    ).toBeVisible();
  },
};

export const GuestPrompting: Story = {
  args: { mic: { status: "prompting" } },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(dialog.getByText("Waiting for your browser…")).toBeVisible();
    await expect(rowState("mic")).toBe("running");
    await expect(dialog.getByText("Answer your browser first")).toBeVisible();
  },
};

export const GuestDenied: Story = {
  args: { mic: { status: "denied" } },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(dialog.getByText("Microphone blocked")).toBeVisible();
    await userEvent.click(
      dialog.getByRole("button", { name: "How to allow the microphone" }),
    );
    await expect(args.onMicAction).toHaveBeenCalledWith("how-to");
  },
};

export const GuestInputLost: Story = {
  args: { mic: { status: "lost" }, headphones: true },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(rowState("mic")).toBe("failed");
    await userEvent.click(
      dialog.getByRole("button", { name: "Retry microphone" }),
    );
    await expect(args.onMicAction).toHaveBeenCalledWith("retry");
  },
};

export const GuestReady: Story = {
  args: { mic: MIC_READY, headphones: true },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(rowState("name")).toBe("done");
    await expect(rowState("mic")).toBe("done");
    await expect(rowState("headphones")).toBe("done");
    await expect(
      dialog.getByText(/recorded in full quality on this device/),
    ).toBeVisible();
    const join = dialog.getByRole("button", { name: "Join and record" });
    await expect(join).toBeEnabled();
    await userEvent.click(join);
    await expect(args.onJoin).toHaveBeenCalledTimes(1);
  },
};

export const GuestClippedDuringCheck: Story = {
  args: {
    mic: { ...MIC_READY, level: 1, clipped: true },
    headphones: true,
  },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(
      dialog.getByText("Too loud. Move back a little."),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Join and record" }),
    ).toBeEnabled();
  },
};

export const GuestLowStorage: Story = {
  args: { mic: MIC_READY, headphones: true, lowStorage: true },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(
      dialog.getByText("Low space on this device. Close other tabs."),
    ).toBeVisible();
  },
};

export const GuestStorageBlocked: Story = {
  args: {
    mic: MIC_READY,
    headphones: true,
    blocker: {
      text: "This browser can't keep a recording on this device.",
      action: { label: "Retry storage check" },
    },
    onBlockerAction: fn(),
  },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(rowState("storage")).toBe("failed");
    await expect(
      dialog.getByRole("button", { name: "Join and record" }),
    ).toBeDisabled();
    await expect(dialog.getByText("Fix storage first")).toBeVisible();
    await userEvent.click(
      dialog.getByRole("button", { name: "Retry storage check" }),
    );
    await expect(args.onBlockerAction).toHaveBeenCalledTimes(1);
  },
};

export const GuestStaleInput: Story = {
  args: {
    mic: {
      ...MIC_READY,
      devices: [
        { id: "usb", label: "USB Condenser" },
        { id: "built-in", label: "MacBook Pro Microphone" },
      ],
      inputId: "",
    },
    micNotes: [
      "Your saved microphone isn't available, so the default input is in use.",
    ],
    headphones: true,
    onInputChange: fn(),
  },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(
      dialog.getByText(/saved microphone isn't available/),
    ).toBeVisible();
    await userEvent.selectOptions(
      dialog.getByRole("combobox", { name: "Input" }),
      "usb",
    );
    await expect(args.onInputChange).toHaveBeenCalledWith("usb");
  },
};

export const GuestRejoin: Story = {
  args: { mic: MIC_READY, headphones: true, rejoin: true },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await waitFor(() =>
      expect(
        dialog.getByRole("button", { name: "Join and record" }),
      ).toHaveFocus(),
    );
  },
};

export const GuestJoining: Story = {
  args: { mic: MIC_READY, headphones: true, joining: true, phase: LIVE },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    const join = dialog.getByRole("button", { name: "Joining…" });
    await expect(join).toBeDisabled();
    await expect(join).toHaveAttribute("aria-busy", "true");
  },
};

export const GuestPhone: Story = {
  args: { viewerWidth: "phone", name: "" },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(dialog.getByText("Add your name first")).toBeVisible();
    await userEvent.type(dialog.getByLabelText("Your name"), "Jon");
    await waitFor(() => expect(rowState("name")).toBe("done"));
    await expect(dialog.getByText("Allow your microphone first")).toBeVisible();
  },
};

export const GuestPhoneReady: Story = {
  args: { viewerWidth: "phone", mic: MIC_READY, headphones: true },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(
      dialog.getByRole("button", { name: "Join and record" }),
    ).toBeEnabled();
  },
};

export const Producer: Story = {
  args: { seat: "producer", name: "Rosa Diaz" },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(
      dialog.getByText("You'll listen and take notes. You won't be recorded."),
    ).toBeVisible();
    await expect(dialog.queryByText("Microphone")).toBeNull();
    await userEvent.click(
      dialog.getByRole("button", { name: "Join to listen" }),
    );
    await expect(args.onJoin).toHaveBeenCalledTimes(1);
  },
};

export const ProducerPhone: Story = {
  args: { seat: "producer", viewerWidth: "phone", name: "" },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(
      dialog.getByRole("button", { name: "Join to listen" }),
    ).toBeDisabled();
    await expect(dialog.getByText("Add your name first")).toBeVisible();
  },
};
