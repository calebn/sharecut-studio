import { type ReactNode, useEffect, useState } from "react";
import { getEditorCutTotal } from "../api";
import { hasShareCapability, shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { EditorCutTotal } from "./useEditorCutTotal";

export function EditorCutTotalProvider({ children }: { children: ReactNode }) {
  const path = useDawStore((s) => s.projectPath);
  const canRead = useDawStore((s) =>
    hasShareCapability(s.shareCapabilities, "edit"),
  );
  const history = useDawStore((s) => s.project?.history);
  const hasProject = useDawStore((s) => s.project !== null);
  const isEditor = canRead && Boolean(shareTokenFromKey(path));
  const head = history?.edit_head_id ?? history?.head_id ?? null;
  const epoch = useDawStore((s) => s.projectEpoch);
  const key =
    isEditor && hasProject ? JSON.stringify([path, epoch, head]) : null;
  const [result, setResult] = useState<{ key: string; seconds: number } | null>(
    null,
  );

  useEffect(() => {
    if (key === null) return;
    const requestKey = key;
    const controller = new AbortController();
    async function read() {
      try {
        const seconds = await getEditorCutTotal(path, controller.signal);
        if (!controller.signal.aborted) setResult({ key: requestKey, seconds });
      } catch {
        // The guest placeholder is not a measured total.
      }
    }
    void read();
    return () => controller.abort();
  }, [key, path]);

  const seconds = isEditor
    ? result !== null && result.key === key
      ? result.seconds
      : null
    : undefined;
  return (
    <EditorCutTotal.Provider value={seconds}>
      {children}
    </EditorCutTotal.Provider>
  );
}
