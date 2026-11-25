import { type ReactNode, useEffect, useState } from "react";
import { apiFetch } from "../api/http";
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
        const response = await apiFetch(
          path,
          { guest: "/daw/edit-impact" },
          { signal: controller.signal },
        );
        const { total_removed_sec: seconds } = (await response.json()) as {
          total_removed_sec: unknown;
        };
        if (
          !controller.signal.aborted &&
          typeof seconds === "number" &&
          Number.isFinite(seconds) &&
          seconds >= 0
        ) {
          setResult({ key: requestKey, seconds });
        }
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
