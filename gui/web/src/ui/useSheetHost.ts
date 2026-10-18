import { useState } from "react";

/**
 * The one DOM element a BottomSheet portals into, whatever its placement. The
 * sheet lives under `<body>` with its scrim; the Inspector column lives in the
 * shell's grid (#1696). Portaling into a container that changes would unmount
 * the subtree and lose its drafts and focus when the phone turns, so the
 * container stays and its parent switches instead.
 */
export function useSheetHost(): HTMLDivElement | null {
  const [host] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  return host;
}
