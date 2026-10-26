import type { Decorator, Parameters } from "@storybook/react-vite";
import "./story-layout.css";

export const viewportStoryParameters = {
  layout: "fullscreen",
  docs: { canvas: { className: "studio-story-viewport" } },
} satisfies Parameters;

export const studioViewports = {
  desktop: {
    name: "Desktop 1440",
    styles: { width: "1440px", height: "900px" },
    type: "desktop",
  },
  tablet: {
    name: "Tablet 834",
    styles: { width: "834px", height: "1112px" },
    type: "tablet",
  },
  mobile360: {
    name: "Phone 360",
    styles: { width: "360px", height: "740px" },
    type: "mobile",
  },
} as const;

export const isolatedStoryParameters = {
  ...viewportStoryParameters,
  docs: {
    ...viewportStoryParameters.docs,
    story: { inline: false, height: "40rem" },
  },
} satisfies Parameters;

export const desktopStoryParameters = {
  ...isolatedStoryParameters,
  docs: {
    ...isolatedStoryParameters.docs,
    canvas: {
      className: "studio-story-viewport studio-story-viewport--desktop",
    },
  },
} satisfies Parameters;

/**
 * For overlays the app portals to `document.body` (create menu, target
 * chooser, open transport menus): they sit outside every landmark by design,
 * which the best-practice `region` rule reports. The studio's e2e axe runs
 * turn that rule off for the same reason (`e2e/axe.ts`).
 */
export const portaledOverlayParameters = {
  a11y: { config: { rules: [{ id: "region", enabled: false }] } },
} satisfies Parameters;

export const menuStoryDecorator: Decorator = (Story) => (
  <div
    style={{
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "flex-end",
      minBlockSize: "18rem",
    }}
  >
    <Story />
  </div>
);
