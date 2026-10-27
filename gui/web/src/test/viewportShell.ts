import { vi } from "vitest";
import { PHONE_MQ, TABLET_MQ } from "../hooks/useViewportClass";
import type { ShellBreakpoint } from "../state/types";

const SIDE_BY_SIDE_MQ = "(min-width: 62.5rem)";

/** Stub the media queries that pick the shell and the Edit arrangement. */
export function stubViewportShell(
  shell: ShellBreakpoint,
  { wide = shell !== "phone" }: { wide?: boolean } = {},
): void {
  const matches = (query: string): boolean => {
    if (query === PHONE_MQ) return shell === "phone";
    if (query === TABLET_MQ) return shell !== "desktop";
    if (query === SIDE_BY_SIDE_MQ) return wide;
    return false;
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
