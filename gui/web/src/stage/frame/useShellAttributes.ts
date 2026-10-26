import { useEffect } from "react";
import { useViewportClass } from "../../hooks/useViewportClass";
import { useDawStore } from "../../state/dawStore";
import type { ShellBreakpoint } from "../../state/types";

/**
 * The viewport class, written to the store and to `data-shell` on the root.
 * `shellBreakpoint` feeds many hooks and CSS rules, so the frame keeps
 * publishing it.
 */
export function useShellAttributes(): ShellBreakpoint {
  const shell = useViewportClass();
  const setShellBreakpoint = useDawStore((s) => s.setShellBreakpoint);
  useEffect(() => {
    setShellBreakpoint(shell);
    document.documentElement.dataset.shell = shell;
  }, [shell, setShellBreakpoint]);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.shell;
    },
    [],
  );
  return shell;
}
