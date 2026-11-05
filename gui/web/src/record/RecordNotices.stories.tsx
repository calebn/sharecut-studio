import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { StorageHeadroomWarning } from "./StorageHeadroomWarning";

function installStorageEstimate(
  estimate: { quota: number; usage: number } | null,
) {
  const original = Object.getOwnPropertyDescriptor(navigator, "storage");
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: estimate ? { estimate: () => Promise.resolve(estimate) } : {},
  });
  return () => {
    if (original) Object.defineProperty(navigator, "storage", original);
    else Reflect.deleteProperty(navigator, "storage");
  };
}

const meta: Meta = {
  title: "Templates/Record · Notices",
  parameters: { ...isolatedStoryParameters, layout: "padded" },
};

export default meta;
type Story = StoryObj;

export const StorageLow: Story = {
  beforeEach: () =>
    installStorageEstimate({ quota: 400_000_000, usage: 100_000_000 }),
  render: () => <StorageHeadroomWarning />,
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole("status");
    await waitFor(() => expect(status).not.toBeEmptyDOMElement());
  },
};

export const StorageUnknown: Story = {
  beforeEach: () => installStorageEstimate(null),
  render: () => <StorageHeadroomWarning />,
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole("status");
    await waitFor(() => expect(status).not.toBeEmptyDOMElement());
  },
};
