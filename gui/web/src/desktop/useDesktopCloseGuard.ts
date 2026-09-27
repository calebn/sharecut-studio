import { isTauri } from "@tauri-apps/api/core";
import { useLayoutEffect } from "react";

export type RecordingRole = "host" | "guest";

// The native close handler reads this from the current WebView URL. A history
// update stays on the existing loopback page and needs no remote Tauri IPC.
export const CLOSE_GUARD_PARAM = "sc_close_guard";

// The same risk in page memory: a plain browser tab gets no URL marker, but
// its keeper's beforeunload prompt would still cancel a project switch.
let pageCloseRisk = false;

export function _resetPageCloseRiskForTests(): void {
  pageCloseRisk = false;
}

/** An armed guard (native marker or this page's recording risk) blocks leaving the project that owns the room. */
export function desktopCloseGuardArmed(): boolean {
  return (
    pageCloseRisk ||
    new URL(window.location.href).searchParams.has(CLOSE_GUARD_PARAM)
  );
}

/** Update the current WebView URL before an asynchronous recording transition. */
export function publishDesktopCloseGuard(
  closeRisk: boolean,
  role: RecordingRole,
  canClear = true,
): void {
  if (closeRisk) {
    pageCloseRisk = true;
  } else if (canClear) {
    pageCloseRisk = false;
  }
  if (!isTauri()) {
    return;
  }
  const url = new URL(window.location.href);
  if (closeRisk) {
    url.searchParams.set(CLOSE_GUARD_PARAM, role);
  } else if (canClear) {
    url.searchParams.delete(CLOSE_GUARD_PARAM);
  }
  if (url.href !== window.location.href) {
    window.history.replaceState(window.history.state, "", url);
  }
}

/**
 * Publishes recording risk for the native Rust close handler without invoking
 * a Tauri plugin from the loopback WebView.
 */
export function useDesktopCloseGuard(
  closeRisk: boolean,
  role: RecordingRole,
  canClear = true,
): void {
  useLayoutEffect(() => {
    publishDesktopCloseGuard(closeRisk, role, canClear);
  }, [closeRisk, role, canClear]);
}
