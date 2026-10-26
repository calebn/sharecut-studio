import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { MicLossNotice } from "./MicLossNotice";
import { NoAudioNotice } from "./NoAudioNotice";
import { recordStoryDecorator } from "./recordStoryDecorator";
import { StorageHeadroomWarning } from "./StorageHeadroomWarning";

function StorageEstimate({
  estimate,
  children,
}: {
  estimate: { quota: number; usage: number } | null;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const original = Object.getOwnPropertyDescriptor(navigator, "storage");
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: estimate ? { estimate: () => Promise.resolve(estimate) } : {},
    });
    setReady(true);
    return () => {
      setReady(false);
      if (original) Object.defineProperty(navigator, "storage", original);
      else Reflect.deleteProperty(navigator, "storage");
    };
  }, [estimate]);
  return ready ? children : null;
}

const meta: Meta = {
  title: "Templates/Record · Notices",
  decorators: [recordStoryDecorator],
  parameters: { ...isolatedStoryParameters, layout: "padded" },
};

export default meta;
type Story = StoryObj;

export const MicrophoneLost: Story = {
  render: () => <MicLossNotice onRetry={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Full-quality recording is paused.",
    );
    await expect(canvas.getByRole("button")).toBeVisible();
  },
};

export const NoAudio: Story = {
  render: () => <NoAudioNotice onCheck={fn()} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toBeVisible();
  },
};

export const NoAudioCheckFailed: Story = {
  render: () => <NoAudioNotice onCheck={fn()} checkFailed />,
};

export const StorageLow: Story = {
  render: () => (
    <StorageEstimate estimate={{ quota: 400_000_000, usage: 100_000_000 }}>
      <StorageHeadroomWarning />
    </StorageEstimate>
  ),
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole("status");
    await waitFor(() => expect(status).not.toBeEmptyDOMElement());
  },
};

export const StorageUnknown: Story = {
  render: () => (
    <StorageEstimate estimate={null}>
      <StorageHeadroomWarning />
    </StorageEstimate>
  ),
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole("status");
    await waitFor(() => expect(status).not.toBeEmptyDOMElement());
  },
};
