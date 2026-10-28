import type { Meta } from "@storybook/react-vite";

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
} as const satisfies Pick<Meta, "parameters" | "globals">;
