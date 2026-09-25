import { type ReactNode, useEffect } from "react";
import type { ProjectView } from "../types/project";
import { useDawStore } from "./dawStore";

/**
 * Thin provider: hydrates the Zustand DAW store from App bootstrap props.
 * Use `useDaw(selector)` / `useDawStore` selectors.
 */
export function DawProvider({
  children,
  projectPath,
  initialProject,
  guestMode = null,
  shareCapabilities = null,
}: {
  children: ReactNode;
  projectPath: string;
  initialProject: ProjectView | null;
  guestMode?: string | null;
  shareCapabilities?: string[] | null;
}) {
  const hydrate = useDawStore((s) => s.hydrate);
  useEffect(() => {
    hydrate(projectPath, initialProject, guestMode, shareCapabilities);
  }, [hydrate, projectPath, initialProject, guestMode, shareCapabilities]);
  return <>{children}</>;
}
