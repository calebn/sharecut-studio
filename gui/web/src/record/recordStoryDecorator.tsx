import type { Decorator } from "@storybook/react-vite";
import "../styles/partials/record-entry.css";

/**
 * Wrap a record-surface story in the production shell classes so
 * `.record-shell` / `.review-shell` styles apply as they do in `RecordApp`.
 * A `div` (not `main`) avoids a second main landmark in the Storybook canvas.
 */
export const recordStoryDecorator: Decorator = (Story) => (
  <div className="cover review-shell record-shell">
    <Story />
  </div>
);

/** Phone-width viewport for guest record surfaces (360px, per #173). */
export const recordMobileViewport = {
  parameters: {
    viewport: {
      options: {
        mobile360: {
          name: "Mobile 360",
          styles: { width: "360px", height: "740px" },
          type: "mobile",
        },
      },
    },
  },
  globals: { viewport: { value: "mobile360", isRotated: false } },
} as const;
