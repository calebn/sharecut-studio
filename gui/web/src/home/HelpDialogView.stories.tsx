import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher, useArgState } from "../test/storyDialog";
import { HelpDialogView } from "./HelpDialogView";

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open help dialog",
    dialogName: "Help",
  });

const SUPPORT = "https://github.com/example/sharecut/issues";

const bundle = {
  path: "/Users/mira/Downloads/sharecut-diagnostics-2031-04-02.zip",
  filename: "sharecut-diagnostics-2031-04-02.zip",
  support_url: SUPPORT,
  size_bytes: 48_230,
  files: ["app.log", "environment.json", "pipeline.json"],
  app_version: "0.9.0",
  created_at: "2031-04-02T10:15:00Z",
};

function HelpDialogPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof HelpDialogView> & { initiallyOpen: boolean }) {
  const [description, setDescription] = useArgState(args.description);
  const [consent, setConsent] = useArgState(args.consent);
  return (
    <DialogLauncher label="Open help dialog" initiallyOpen={initiallyOpen}>
      {(open, close) => (
        <HelpDialogView
          {...args}
          open={open}
          description={description}
          consent={consent}
          onClose={() => {
            close();
            args.onClose();
          }}
          onDescriptionChange={(next) => {
            setDescription(next);
            args.onDescriptionChange(next);
          }}
          onConsentChange={(next) => {
            setConsent(next);
            args.onConsentChange(next);
          }}
        />
      )}
    </DialogLauncher>
  );
}

const meta: Meta<typeof HelpDialogView> = {
  title: "Templates/HelpDialog",
  component: HelpDialogView,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    busy: false,
    error: null,
    bundle: null,
    description: "",
    onDescriptionChange: fn(),
    consent: false,
    onConsentChange: fn(),
    submitted: null,
    reportStatus: null,
    issueUrl: null,
    reportAvailable: true,
    issueHref: SUPPORT,
    fallbackHref: `${SUPPORT}/new?template=bug_report.yml`,
    onCreate: fn(),
    onSubmit: fn(),
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <HelpDialogPreview {...args} initiallyOpen={context.viewMode === "story"} />
  ),
};

export default meta;
type Story = StoryObj<typeof HelpDialogView>;

export const Idle: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create diagnostics bundle" }),
    );
    await expect(args.onCreate).toHaveBeenCalledOnce();
    await expect(
      within(dialog).getByRole("link", { name: "Open support" }),
    ).toBeVisible();
  },
};

export const Creating: Story = {
  args: { busy: true },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("button", { name: "Creating…" }),
    ).toBeDisabled();
  },
};

export const CreateFailed: Story = {
  args: { error: "Could not write the diagnostics zip: the disk is full." },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(within(dialog).getByText(/the disk is full/)).toBeVisible();
  },
};

export const BundleReady: Story = {
  args: { bundle },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText(/Bundle size: 47.1 KiB/),
    ).toBeVisible();
    await expect(
      within(dialog).getByRole("button", { name: "Submit report" }),
    ).toBeDisabled();
  },
};

export const ReadyToSubmit: Story = {
  args: {
    bundle,
    description: "The export stalls at 80% on the second render.",
    consent: true,
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Submit report" }),
    );
    await expect(args.onSubmit).toHaveBeenCalledOnce();
  },
};

export const BundleOnly: Story = {
  args: { bundle, reportAvailable: false },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).queryByRole("button", { name: "Submit report" }),
    ).toBeNull();
  },
};

export const Published: Story = {
  args: {
    bundle,
    description: "The export stalls at 80% on the second render.",
    consent: true,
    submitted: `${SUPPORT}/reports/r-41`,
    reportStatus: "published",
    issueUrl: `${SUPPORT}/311`,
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("link", { name: "Open published issue" }),
    ).toBeVisible();
  },
};

export const PublicationFailed: Story = {
  args: {
    bundle,
    description: "The export stalls at 80% on the second render.",
    consent: true,
    submitted: `${SUPPORT}/reports/r-41`,
    reportStatus: "failed",
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText(/Report publication failed/),
    ).toBeVisible();
  },
};
