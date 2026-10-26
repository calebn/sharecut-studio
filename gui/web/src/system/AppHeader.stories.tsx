import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { AppHeader, type AppHeaderProps } from "./AppHeader";
import { StageBar } from "./StageBar";
import type { StageId } from "./verbs";

const meta: Meta<typeof AppHeader> = {
  title: "System/AppHeader",
  component: AppHeader,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <main aria-label="Project">
        <Story />
      </main>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Project menu, Save indicator, Undo and Redo on the left; the Stage bar in the center; people, Invite and Palette on the right. The Stage bar and people hide when the header is narrower than 40rem: the phone has the tab bar instead.\n\n**Motion.** None in this slice. Menu opens with `--motion-hover` through `ui/Menu`; the Save check fades with `--motion-state` once the animation pass lands.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AppHeader>;

const people = [
  { name: "Maya Chen", colorIndex: 0 },
  { name: "Rosa Diaz", colorIndex: 1 },
  { name: "Tom Park", colorIndex: 2 },
  { name: "Ines Ortiz", colorIndex: 3 },
  { name: "Lee Kim", colorIndex: 4 },
];

function Header(
  props: Partial<AppHeaderProps> & {
    withStages?: boolean;
    stageIds?: readonly StageId[];
  },
) {
  const { withStages = true, stageIds, ...rest } = props;
  const [active, setActive] = useState<StageId>("edit");
  return (
    <AppHeader
      title="Episode 14 - The long way round"
      save={{ state: "saved" }}
      recent={["Episode 13", "Episode 12", "Pilot cut"]}
      people={people}
      stages={
        withStages
          ? {
              active,
              onSelect: setActive,
              stages: stageIds,
              badges: { review: { kind: "needs-you", count: 6 } },
            }
          : undefined
      }
      {...rest}
    />
  );
}

export const Host: Story = {
  render: () => <Header />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The Stage bar shows labels from 1100 px up and icons only below it.
    // Inside the header that is the header's width, not the bar's.
    const host = canvasElement.querySelector(".sys-app-header-host");
    const labels = canvasElement.querySelectorAll(
      '[role="tab"][aria-selected="false"] .sys-stage-label',
    );
    const wide = (host?.getBoundingClientRect().width ?? 0) > 1100;
    if (wide) {
      await expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        await expect(label.getBoundingClientRect().width).toBeGreaterThan(24);
      }
    }
    await userEvent.click(canvas.getByRole("button", { name: /Episode 14/ }));
    const body = within(document.body);
    await expect(
      await body.findByRole("menuitem", { name: "All projects" }),
    ).toBeVisible();
    await expect(
      body.getByRole("menuitem", {
        name: /Rename project,\s*Episode 14 - The long way round/,
      }),
    ).toBeVisible();
  },
};

export const Guest: Story = {
  render: () => (
    <Header
      guest={{ version: "v3", role: "Commenter" }}
      people={people.slice(0, 2)}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Invite" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Undo" })).toBeNull();
  },
};

export const GuestEditor: Story = {
  render: () => (
    <Header
      guest={{ version: "v3", role: "Editor" }}
      people={people.slice(0, 2)}
      stageIds={["edit", "review"]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Invite" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeVisible();
  },
};

export const GuestViewer: Story = {
  render: () => (
    <Header guest={{ version: "v3", role: "Viewer" }} withStages={false} />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("button", { name: "Invite" }),
    ).toBeNull();
  },
};

export const Loading: Story = {
  render: () => <Header loading people={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: /Episode 14/ }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeDisabled();
    await expect(canvas.queryByRole("status")).toBeNull();
  },
};

export const Offline: Story = {
  render: () => <Header save={{ state: "offline", waiting: 2 }} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "2 waiting",
    );
  },
};

export const Failed: Story = {
  render: () => <Header save={{ state: "failed" }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("Save failed");
    await expect(canvas.getByRole("button", { name: /Retry/ })).toBeVisible();
  },
};

export const Phone: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minBlockSize: "24rem",
      }}
    >
      <Header withStages={false} />
      <div style={{ flex: 1 }} />
      <StageBar form="tabs" active="edit" onSelect={() => undefined} />
    </div>
  ),
};

export const RecordGuest: Story = {
  render: () => (
    <Header
      withStages={false}
      guest={{ version: "Room", role: "Editor" }}
      title="Episode 14 recording"
      people={[]}
    />
  ),
};
