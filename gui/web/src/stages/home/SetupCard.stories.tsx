import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { SetupCard } from "./SetupCard";

const meta: Meta<typeof SetupCard> = {
  title: "Stages/Home/SetupCard",
  component: SetupCard,
  tags: ["autodocs"],
  args: {
    state: "needed",
    sizeLabel: "about 2 GB",
    onGetReady: fn(),
    onChoose: fn(),
    onCancel: fn(),
    onRetry: fn(),
    onNotNow: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The Setup card on Home, shown only while models are missing. Needed: "Get ready" starts the one download, "Choose…" opens Models, and "Not now" in the more menu hides it until the next launch. Downloading is one progress row with Cancel; the person can import or record meanwhile. Failed and the check error say what happened in one line with "Try again" and never show raw error text. The size comes from the caller as words ("about 2 GB").\n\n**Motion.** The card changes state in place with `--motion-hover` on the bar fill; dismissing leaves with `--motion-panel`.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SetupCard>;

export const Needed: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Get ready" }));
    await expect(args.onGetReady).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Choose…" }));
    await expect(args.onChoose).toHaveBeenCalledOnce();
    await userEvent.click(
      canvas.getByRole("button", { name: "More about setup" }),
    );
    const body = within(document.body);
    await userEvent.click(body.getByRole("menuitem", { name: "Not now" }));
    await expect(args.onNotNow).toHaveBeenCalledOnce();
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
  },
};
export const Downloading: Story = {
  args: {
    state: "downloading",
    progress: 0.55,
    detail: "1.1 of 2.0 GB · about 3 min",
  },
};
export const Failed: Story = { args: { state: "failed" } };
export const CheckError: Story = { args: { state: "check-error" } };
export const Phone: Story = {};
