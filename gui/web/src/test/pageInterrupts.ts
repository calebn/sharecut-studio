import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

export const pageInterrupts = {
  blur: () => fireEvent.blur(window),
  pagehide: () => fireEvent(window, new Event("pagehide")),
  hidden: () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
  },
};

export type PageInterrupt = keyof typeof pageInterrupts;
