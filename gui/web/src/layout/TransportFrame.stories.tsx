import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  Button,
  Icon,
  Pill,
  pillClassName,
  SegmentedControl,
  Timecode,
  ToggleButton,
} from "../ui";
import { transportTimecode } from "../utils/time";
import { TransportFrame, TransportZone } from "./TransportFrame";
import { TransportPlayControls } from "./TransportPlayControls";

const TIMECODE = transportTimecode(12.48, 60);

/**
 * The fixed dark transport assembled from its presentational pieces with
 * static content. The live bar (TransportBar) adds command wiring, the
 * store-driven tool cluster, avatars, and menus.
 */
const meta: Meta<typeof TransportFrame> = {
  title: "Templates/Transport",
  component: TransportFrame,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof TransportFrame>;

const MODES = ["Mix", "FX", "Raw"] as const;

function TransportTemplate({
  collapsed = false,
  stale = false,
  initiallyPlaying = false,
}: {
  collapsed?: boolean;
  stale?: boolean;
  initiallyPlaying?: boolean;
}) {
  const [playing, setPlaying] = useState(initiallyPlaying);
  const [mode, setMode] = useState<(typeof MODES)[number]>("Mix");
  return (
    <>
      <div style={{ blockSize: "var(--transport-height)" }}>
        <TransportFrame collapsed={collapsed} playing={playing}>
          <TransportZone position="start">
            <h1>Episode 12: Field notes</h1>
          </TransportZone>
          <TransportZone position="center">
            <div className="transport-play">
              <TransportPlayControls
                playing={playing}
                onTogglePlay={() => setPlaying((value) => !value)}
                onStop={() => setPlaying(false)}
              />
            </div>
            <Timecode
              current={TIMECODE.current}
              total={collapsed ? undefined : TIMECODE.total}
              title={TIMECODE.title}
            />
            {collapsed ? null : (
              <SegmentedControl
                className="audition-modes"
                label="Audition mode"
              >
                {MODES.map((m) => (
                  <ToggleButton
                    key={m}
                    quiet
                    pressed={mode === m}
                    onClick={() => setMode(m)}
                  >
                    {m}
                  </ToggleButton>
                ))}
              </SegmentedControl>
            )}
          </TransportZone>
          <TransportZone position="end">
            {collapsed ? null : stale ? (
              // Same action pill the live bar renders: a bare ui-control
              // button (CommandButton bare) with the shared pill classes.
              <button
                type="button"
                className={`ui-control ${pillClassName("warning", "pill--action")}`}
                title="Stale stems: reference, guest. Click to refresh mix."
              >
                Stale render
              </button>
            ) : (
              <Pill tone="ok">Fresh</Pill>
            )}
            <div className="transport-primary-actions">
              <Button
                className="ui-control--compact transport-icon-btn fit-btn"
                aria-label="Fit"
              >
                <Icon name="fit" />
              </Button>
              {collapsed ? null : (
                <Button
                  className="ui-control--compact transport-icon-btn transport-more-btn"
                  aria-label="View"
                >
                  <Icon name="layers" />
                </Button>
              )}
              <Button
                className="ui-control--compact transport-icon-btn transport-more-btn"
                aria-label="Menu"
              >
                <Icon name="menu" />
              </Button>
            </div>
          </TransportZone>
        </TransportFrame>
      </div>
      {/* The banner sits beside the page's main region, as in the app. */}
      <main
        aria-label="Stage"
        style={{
          blockSize: "12rem",
          background: "var(--color-timeline-well)",
        }}
      />
    </>
  );
}

export const Wide: Story = {
  render: () => <TransportTemplate />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    await expect(
      await canvas.findByRole("button", { name: "Pause" }),
    ).toBeTruthy();
    await expect(canvasElement.querySelector(".transport")).toHaveAttribute(
      "data-playing",
      "true",
    );
  },
};

export const Playing: Story = {
  render: () => <TransportTemplate initiallyPlaying />,
};

export const StaleRender: Story = {
  render: () => <TransportTemplate stale />,
};

export const Collapsed: Story = {
  render: () => <TransportTemplate collapsed />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
