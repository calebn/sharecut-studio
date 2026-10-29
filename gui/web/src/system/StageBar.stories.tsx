import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import type { StageId } from "../types/stage";
import { StageBar, type StageBarProps } from "./StageBar";

const meta: Meta<typeof StageBar> = {
  title: "System/StageBar",
  component: StageBar,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Five stages in one tab list. Below a 1100 px container the inactive segments show the icon only (a container query, so the same story fits 360 and 1280). The phone form is a tab bar: a 24 px icon over an 11 px label. Record says nothing when idle, then a count while people wait, the red take clock while live, Paused, a ring while saving, the offline glyph while reconnecting and an amber dot for any alert.\n\n**Motion.** The active segment moves with `--motion-panel` once the animation pass lands; nothing animates in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StageBar>;

function Bar(props: Partial<StageBarProps>) {
  const [active, setActive] = useState<StageId>(props.active ?? "edit");
  return (
    <div style={{ padding: "var(--space-5)" }}>
      <StageBar {...props} active={active} onSelect={setActive} />
    </div>
  );
}

export const Desktop: Story = {
  render: () => <Bar />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const edit = canvas.getByRole("tab", { name: /Edit/ });
    edit.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: /Review/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{Home}");
    await expect(canvas.getByRole("tab", { name: /Record/ })).toHaveFocus();
  },
};

export const Narrow: Story = {
  render: () => (
    <div style={{ maxInlineSize: "30rem" }}>
      <Bar active="prepare" />
    </div>
  ),
};

export const Phone: Story = {
  render: () => <Bar form="tabs" active="review" />,
};

export const AllBadges: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Review 6, Needs you" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("tab", { name: "Deliver Failed" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("tab", { name: "Record 2, Waiting to send" }),
    ).toBeVisible();
  },
  render: () => (
    <Bar
      badges={{
        record: { kind: "offline", count: 2 },
        prepare: { kind: "running" },
        edit: { kind: "not-yet" },
        review: { kind: "needs-you", count: 6 },
        deliver: { kind: "failed" },
      }}
    />
  ),
};

export const DoneBadge: Story = {
  render: () => <Bar active="deliver" badges={{ prepare: { kind: "done" } }} />,
};

const live = { kind: "live", clockMs: 724000, receivedAtMs: null } as const;

export const RecordIdle: Story = {
  render: () => <Bar record={{ kind: "idle" }} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("tab", { name: "Record" }),
    ).toBeVisible();
  },
};

export const RecordPeopleWaiting: Story = {
  render: () => <Bar record={{ kind: "waiting", count: 2 }} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("tab", { name: "Record 2 waiting" }),
    ).toBeVisible();
  },
};

export const RecordLive: Story = {
  render: () => <Bar record={live} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Record Live" }),
    ).toBeVisible();
    await expect(canvas.getByText("12:04")).toBeVisible();
  },
};

export const RecordLivePhone: Story = {
  render: () => <Bar form="tabs" active="review" record={live} />,
};

export const RecordLivePhoneHour: Story = {
  render: () => (
    <Bar form="tabs" active="review" record={{ ...live, clockMs: 3723000 }} />
  ),
};

export const RecordPausedPhone: Story = {
  render: () => <Bar form="tabs" active="review" record={{ kind: "paused" }} />,
};

export const RecordPaused: Story = {
  render: () => <Bar record={{ kind: "paused" }} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("tab", { name: "Record Paused" }),
    ).toBeVisible();
  },
};

export const RecordSaving: Story = {
  render: () => <Bar record={{ kind: "saving", progress: 0.4 }} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("tab", { name: "Record Saving" }),
    ).toBeVisible();
  },
};

export const RecordReconnecting: Story = {
  render: () => <Bar record={{ kind: "reconnecting" }} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("tab", { name: "Record Reconnecting" }),
    ).toBeVisible();
  },
};

export const RecordAlert: Story = {
  render: () => <Bar record={{ kind: "alert" }} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("tab", {
        name: "Record Needs attention",
      }),
    ).toBeVisible();
  },
};

export const GuestEditor: Story = {
  render: () => <Bar stages={["edit", "review"]} />,
};
