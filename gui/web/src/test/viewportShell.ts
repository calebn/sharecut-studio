import { vi } from "vitest";
import { SHORT_VIEWPORT_MQ } from "../hooks/useShortViewport";
import { PHONE_MQ, TABLET_MQ } from "../hooks/useViewportClass";
import type { ShellBreakpoint } from "../state/types";

const SIDE_BY_SIDE_MQ = "(min-width: 62.5rem)";

/** Stub layout media queries for the shell, Edit arrangement and short height. */
export function stubViewportShell(
  shell: ShellBreakpoint,
  {
    wide = shell !== "phone",
    short = false,
  }: { wide?: boolean; short?: boolean } = {},
): void {
  const matches = (query: string): boolean => {
    if (query === PHONE_MQ) return shell === "phone";
    if (query === TABLET_MQ) return shell !== "desktop";
    if (query === SIDE_BY_SIDE_MQ) return wide;
    if (query === SHORT_VIEWPORT_MQ) return short;
    return false;
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
