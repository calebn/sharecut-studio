import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { useArgState } from "../../test/storyDialog";
import { HelpSheet, type HelpSheetProps, type HelpStep } from "./HelpSheet";
import { BUNDLE, DESCRIBED } from "./settingsFixtures";

type StoryArgs = HelpSheetProps;

function Harness(args: StoryArgs) {
  const [step, setStep] = useArgState<HelpStep>(args.step);
  const [description, setDescription] = useArgState(args.description);
  return (
    <HelpSheet
      {...args}
      step={step}
      onStepChange={setStep}
      description={description}
      onDescriptionChange={setDescription}
    />
  );
}

const meta: Meta<StoryArgs> = {
  title: "Stages/Settings/HelpSheet",
  component: HelpSheet,
  tags: ["autodocs"],
  render: (args) => <Harness {...args} />,
  args: {
    form: "centered",
    open: true,
    step: "menu",
    description: "",
    preview: { kind: "closed" },
    phase: { kind: "editing" },
    blockedReason: "Describe the problem first.",
    onClose: fn(),
    onStepChange: fn(),
    onShortcuts: fn(),
    onDescriptionChange: fn(),
    onTogglePreview: fn(),
    onSend: fn(),
    onCopyReference: async () => true,
  },
  parameters: {
    ...isolatedStoryParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "Help: three 56 px rows (Shortcuts and gestures opens the Palette, Report a problem pushes a step inside the same sheet, Guides opens the guides in a new tab). Report a problem asks what went wrong, says what the report holds (logs and settings, never audio, transcripts or project files) and offers Preview what's included before the one primary, Send report. The report is built on this computer; only Send uploads it. After send: the reference with Copy. Offline, the report stays on this computer and sends when the connection is back. A centred card on desktop, a bottom sheet on a phone. Presentational: the caller owns the report's state.\n\n**Motion.** The pushed step slides in with `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<StoryArgs>;

const dialog = () =>
  within(document.body).findByRole("dialog", { name: /Help|Report a problem/ });

export const Menu: Story = {
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(sheet.getAllByRole("button").length).toBeGreaterThan(1);
    await expect(sheet.getByRole("link", { name: /Guides/ })).toHaveAttribute(
      "target",
      "_blank",
    );
    await userEvent.click(
      sheet.getByRole("button", { name: /Shortcuts and gestures/ }),
    );
    await expect(args.onShortcuts).toHaveBeenCalled();
  },
};

export const ReportEmpty: Story = {
  args: { step: "report" },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(
      sheet.getByRole("button", { name: "Send report" }),
    ).toBeDisabled();
    await expect(
      sheet.getByText(
        "Includes logs and settings. No audio, transcripts or project files.",
      ),
    ).toBeVisible();
  },
};

export const ReportPreview: Story = {
  args: {
    step: "report",
    description: DESCRIBED,
    blockedReason: undefined,
    preview: { kind: "ready", bundle: BUNDLE },
  },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(
      sheet.getByRole("button", { name: "Preview what's included" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(sheet.getByText("logs/studio.log")).toBeVisible();
  },
};

export const Sending: Story = {
  args: {
    step: "report",
    description: DESCRIBED,
    phase: { kind: "sending" },
  },
};

export const Sent: Story = {
  args: {
    step: "report",
    description: DESCRIBED,
    phase: { kind: "sent", reference: "R-2481" },
  },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(sheet.getByText("Sent.")).toBeVisible();
    await expect(sheet.getByText("Reference R-2481")).toBeVisible();
    await userEvent.click(
      sheet.getByRole("button", { name: "Copy reference" }),
    );
    await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
  },
};

export const Queued: Story = {
  args: {
    step: "report",
    description: DESCRIBED,
    phase: { kind: "queued" },
  },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(sheet.getByText("Saved on this computer.")).toBeVisible();
    await expect(sheet.getByText("It sends when you're online.")).toBeVisible();
  },
};

export const Failed: Story = {
  args: {
    step: "report",
    description: DESCRIBED,
    blockedReason: undefined,
    phase: { kind: "failed", reason: "report relay unavailable" },
  },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(sheet.getByText("Couldn't send the report.")).toBeVisible();
    await userEvent.click(sheet.getByRole("button", { name: "Try again" }));
    await expect(args.onSend).toHaveBeenCalled();
  },
};

export const Phone: Story = {
  args: {
    form: "bottom",
    step: "report",
    description: DESCRIBED,
    blockedReason: undefined,
  },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
