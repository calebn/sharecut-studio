import { vi } from "vitest";
import { SHORT_VIEWPORT_MQ } from "../hooks/useShortViewport";
import { PHONE_MQ, TABLET_MQ } from "../hooks/useViewportClass";
import type { ShellBreakpoint } from "../state/types";
import { COARSE_POINTER_MQ } from "../utils/handheldScreen";

const SIDE_BY_SIDE_MQ = "(min-width: 62.5rem)";

/** Stub layout media queries for the shell, Edit arrangement, short height and handheld landscape. */
export function stubViewportShell(
  shell: ShellBreakpoint,
  {
    wide = shell !== "phone",
    short = false,
    handheld = false,
  }: { wide?: boolean; short?: boolean; handheld?: boolean } = {},
): void {
  const matches = (query: string): boolean => {
    if (query === PHONE_MQ) return shell === "phone";
    if (query === TABLET_MQ) return shell !== "desktop";
    if (query === SIDE_BY_SIDE_MQ) return wide;
    if (query === SHORT_VIEWPORT_MQ) return short;
    if (query === COARSE_POINTER_MQ) return handheld;
    return false;
  };
  // A handheld is a coarse pointer on a 390 x 844 screen (utils/handheldScreen).
  vi.stubGlobal(
    "screen",
    handheld ? { width: 844, height: 390 } : { width: 1024, height: 768 },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
