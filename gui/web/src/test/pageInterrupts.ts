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

const viewport = {
  width: Object.getOwnPropertyDescriptor(window, "innerWidth"),
  height: Object.getOwnPropertyDescriptor(window, "innerHeight"),
};

const setViewport = (key: "innerWidth" | "innerHeight", value: number) =>
  Object.defineProperty(window, key, {
    configurable: true,
    writable: true,
    value,
  });

export const pageRotations = {
  widthResize: () => {
    setViewport("innerWidth", window.innerWidth + 400);
    fireEvent(window, new Event("resize"));
  },
  heightResize: () => {
    setViewport("innerHeight", window.innerHeight + 300);
    fireEvent(window, new Event("resize"));
  },
  orientationchange: () => fireEvent(window, new Event("orientationchange")),
};

export function resetViewport() {
  if (viewport.width)
    Object.defineProperty(window, "innerWidth", viewport.width);
  if (viewport.height)
    Object.defineProperty(window, "innerHeight", viewport.height);
}

export const dragInterrupts = {
  ...pageInterrupts,
  widthResize: pageRotations.widthResize,
  orientationchange: pageRotations.orientationchange,
};

export function trackInterruptSignals() {
  const signals: AbortSignal[] = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, listener: unknown, options?: unknown) => {
      const signal = (options as AddEventListenerOptions | undefined)?.signal;
      if (
        signal &&
        ["blur", "pagehide", "resize", "orientationchange"].includes(type)
      )
        signals.push(signal);
      add(type, listener as EventListener, options as AddEventListenerOptions);
    },
  );
  return {
    registered: () => signals.length,
    live: () => signals.filter((signal) => !signal.aborted).length,
  };
}
