import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CSSProperties } from "react";
import { EmptyState, ToggleButton } from "./index";

/**
 * Color foundations, rendered from the live theme tokens (flip the toolbar
 * theme to compare). Story-only reference: iterate on the palette here
 * before touching components.
 */
const meta: Meta = {
  title: "Atoms/SurfaceLadder",
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj;

const RUNGS = ["canvas", "base", "raised", "overlay", "sunken"] as const;

const swatch = (background: string, color: string): CSSProperties => ({
  display: "grid",
  alignContent: "end",
  gap: "var(--space-1)",
  minBlockSize: "5rem",
  padding: "var(--space-3)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-lg)",
  background,
  color,
  fontSize: "var(--font-size-small)",
});

export const Ladder: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
        gap: "var(--space-3)",
      }}
    >
      {RUNGS.map((rung) => (
        <div
          key={rung}
          style={swatch(
            `var(--color-bg-${rung})`,
            `var(--color-text-on-${rung})`,
          )}
        >
          <strong>{rung}</strong>
          <code>--color-bg-{rung}</code>
        </div>
      ))}
    </div>
  ),
};

export const RolesBesideTheLadder: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
        gap: "var(--space-3)",
      }}
    >
      <div style={swatch("var(--color-field)", "var(--color-text-primary)")}>
        <strong>field</strong>
        <code>--color-field</code>
      </div>
      <div
        style={swatch(
          "var(--color-chip-selected)",
          "var(--color-chip-selected-fg)",
        )}
      >
        <strong>selected chip</strong>
        <code>--color-chip-selected</code>
      </div>
      <div
        style={swatch(
          "var(--color-timeline-well)",
          "var(--color-timeline-text)",
        )}
      >
        <strong>stage well</strong>
        <code>--color-timeline-well</code>
      </div>
      <div
        style={swatch(
          "var(--color-timeline-lane)",
          "var(--color-timeline-text)",
        )}
      >
        <strong>stage lane</strong>
        <code>--color-timeline-lane</code>
      </div>
      <div style={swatch("var(--bg-transport)", "var(--color-transport-text)")}>
        <strong>transport</strong>
        <code>--bg-transport</code>
      </div>
      <div
        style={swatch(
          "var(--color-accent-solid)",
          "var(--color-accent-on-solid)",
        )}
      >
        <strong>accent solid</strong>
        <code>--color-accent-solid</code>
      </div>
      <div style={swatch("var(--color-bg-raised)", "var(--color-danger)")}>
        <strong>danger</strong>
        <code>--color-danger</code>
      </div>
    </div>
  ),
};

/** The one selected language: every toggle, segment, tab, and row. */
export const SelectedStates: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: "var(--space-3)",
        alignItems: "center",
        padding: "var(--space-4)",
        background: "var(--color-bg-base)",
      }}
    >
      <ToggleButton pressed>Follow</ToggleButton>
      <ToggleButton pressed={false}>Select</ToggleButton>
      <ToggleButton quiet pressed>
        Pressed quiet
      </ToggleButton>
      <EmptyState>Nothing selected yet.</EmptyState>
    </div>
  ),
};
