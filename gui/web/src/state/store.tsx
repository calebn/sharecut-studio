import { type ReactNode, useEffect, useRef } from "react";
import type { ProjectView } from "../types/project";
import { useDawStore } from "./dawStore";
import { ShareNameContext } from "./shareName";

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
  shareTranscriptWords = false,
  shareAuthor = null,
  shareName = null,
}: {
  children: ReactNode;
  projectPath: string;
  initialProject: ProjectView | null;
  guestMode?: string | null;
  shareCapabilities?: string[] | null;
  shareTranscriptWords?: boolean;
  shareAuthor?: string | null;
  shareName?: string | null;
}) {
  const hydrate = useDawStore((s) => s.hydrate);
  const hydratedPath = useRef<string | null>(null);
  useEffect(() => {
    // The same project with new access (the saved copy became the live
    // episode) keeps what the studio holds: the project the shell loaded since,
    // the composer's text and the playhead. Only the access changes.
    if (hydratedPath.current === projectPath) {
      useDawStore.setState({
        guestMode,
        shareCapabilities,
        shareTranscriptWords,
        shareAuthor,
      });
      return;
    }
    hydratedPath.current = projectPath;
    hydrate(
      projectPath,
      initialProject,
      guestMode,
      shareCapabilities,
      shareAuthor,
      shareTranscriptWords,
    );
  }, [
    hydrate,
    projectPath,
    initialProject,
    guestMode,
    shareCapabilities,
    shareAuthor,
    shareTranscriptWords,
  ]);
  return (
    <ShareNameContext.Provider value={shareName}>
      {children}
    </ShareNameContext.Provider>
  );
}
