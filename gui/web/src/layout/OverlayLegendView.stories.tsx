import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import { layerVisibility } from "../test/fixtures";
import { OverlayLegendView } from "./OverlayLegendView";

/** Story-local state holder so toggling a checkbox is visible in the canvas. */
function LegendHarness(
  props: Omit<Parameters<typeof OverlayLegendView>[0], "layers"> & {
    initialLayers?: ReturnType<typeof layerVisibility>;
  },
) {
  const { initialLayers, onLayerChange, ...rest } = props;
  const [layers, setLayers] = useState(initialLayers ?? layerVisibility());
  return (
    <OverlayLegendView
      {...rest}
      layers={layers}
      onLayerChange={(key, visible) => {
        setLayers((prev) => ({ ...prev, [key]: visible }));
        onLayerChange?.(key, visible);
      }}
    />
  );
}

const meta: Meta<typeof LegendHarness> = {
  title: "Templates/OverlayLegend",
  component: LegendHarness,
  tags: ["autodocs"],
  decorators: [
    (Story, context) => {
      const host = context.parameters.legendHost;
      if (host === "menu") {
        return (
          <div role="menu" aria-label="View menu" className="ui-menu-panel">
            <div className="ui-menu-section">
              <span className="ui-menu-section-label">Layers</span>
              <Story />
            </div>
          </div>
        );
      }
      if (host === "phone") {
        return (
          <div className="mobile-more-settings">
            <Story />
          </div>
        );
      }
      return <Story />;
    },
  ],
  args: {
    onAddChapter: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Timeline layers" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "+ Chapter" }),
    ).toBeInTheDocument();
  },
};

export const MarkersHidden: Story = {
  args: {
    initialLayers: layerVisibility({ showMarkers: false }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: "+ Chapter" }),
    ).not.toBeInTheDocument();
  },
};

export const ReadOnlyShare: Story = {
  args: {
    onAddChapter: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: "+ Chapter" }),
    ).not.toBeInTheDocument();
  },
};

export const ViewMenu: Story = {
  parameters: { legendHost: "menu" },
  args: { menu: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("menuitemcheckbox")).toHaveLength(6);
    await expect(
      canvas.getByRole("menuitem", { name: "+ Chapter" }),
    ).toBeInTheDocument();
  },
};

export const PhoneWidth: Story = {
  parameters: { legendHost: "phone" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Timeline layers" }),
    ).toBeInTheDocument();
  },
};
