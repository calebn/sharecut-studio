import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { registryModels, withModels } from "../test/modelsStory";
import { useArgState } from "../test/storyDialog";
import { BootstrapWizardView } from "./BootstrapWizardView";
import { HomeScreenView } from "./HomeScreenView";

function HomeScreenPreview(args: ComponentProps<typeof HomeScreenView>) {
  const [name, setName] = useArgState(args.name);
  const [dir, setDir] = useArgState(args.dir);
  const [path, setPath] = useArgState(args.path);
  return (
    <HomeScreenView
      {...args}
      name={name}
      dir={dir}
      path={path}
      onNameChange={(next) => {
        setName(next);
        args.onNameChange(next);
      }}
      onDirChange={(next) => {
        setDir(next);
        args.onDirChange(next);
      }}
      onPathChange={(next) => {
        setPath(next);
        args.onPathChange(next);
      }}
    />
  );
}

const meta: Meta<typeof HomeScreenView> = {
  title: "Templates/Home",
  component: HomeScreenView,
  decorators: [withModels],
  parameters: { layout: "fullscreen" },
  args: {
    wizard: null,
    mode: "idle",
    name: "episode",
    dir: "",
    path: "",
    busyAction: null,
    error: null,
    modelsIncomplete: false,
    dialogs: null,
    onNameChange: fn(),
    onDirChange: fn(),
    onPathChange: fn(),
    onNewMode: fn(),
    onOpenMode: fn(),
    onCancel: fn(),
    onCreate: fn(),
    onOpen: fn(),
    onBrowse: fn(),
    onConnectAgent: fn(),
    onModels: fn(),
    onHelp: fn(),
  },
  render: (args) => <HomeScreenPreview {...args} />,
};

export default meta;
type Story = StoryObj<typeof HomeScreenView>;

export const Idle: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "New project…" }));
    await expect(args.onNewMode).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Help" }));
    await expect(args.onHelp).toHaveBeenCalledOnce();
  },
};

export const ModelsIncomplete: Story = {
  args: { modelsIncomplete: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Models · setup incomplete",
      }),
    ).toBeVisible();
  },
};

export const NewProject: Story = {
  args: { mode: "new" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const create = canvas.getByRole("button", { name: "Create" });
    await expect(create).toBeDisabled();
    await userEvent.type(
      canvas.getByLabelText("Workspace directory"),
      "/episodes/after-hours",
    );
    await expect(create).toBeEnabled();
    await userEvent.click(create);
    await expect(args.onCreate).toHaveBeenCalledOnce();
  },
};

export const Creating: Story = {
  args: {
    mode: "new",
    dir: "/episodes/after-hours",
    busyAction: "create",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Creating…" }),
    ).toBeDisabled();
  },
};

export const OpenProject: Story = {
  args: { mode: "open" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Browse…" }));
    await expect(args.onBrowse).toHaveBeenCalledOnce();
    await expect(canvas.getByRole("button", { name: "Open" })).toBeDisabled();
  },
};

export const Browsing: Story = {
  args: { mode: "open", busyAction: "browse" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Browsing…" }),
    ).toBeDisabled();
  },
};

export const OpenFailed: Story = {
  args: {
    mode: "open",
    path: "/episodes/missing/episode.project.json",
    error: "No episode project was found at that path.",
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "No episode project was found",
    );
  },
};

export const Setup: Story = {
  args: {
    wizard: (
      <BootstrapWizardView
        models={registryModels()}
        loadError={null}
        toolsOk
        busy={false}
        summary="Download 1.6 GB"
        summaryId="home-setup-summary"
        stuckReason={undefined}
        stuckId="home-setup-stuck"
        continueReason={undefined}
        actionFor={(model) => ({
          kind: "select",
          checked: model.tier !== "offered",
          locked: model.tier === "required",
          onToggle: fn(),
        })}
        onContinue={fn()}
        onSkip={fn()}
      />
    ),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("region", { name: "Setup" }),
    ).toBeVisible();
  },
};
