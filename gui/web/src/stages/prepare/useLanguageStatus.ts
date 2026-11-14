import { useEffect, useState } from "react";
import { loadTranscriptLanguageStatus, type StaleTrack } from "../../api";
import { languageName } from "./whisperLanguages";

export type LanguageStatus = {
  language: string | null;
  stale: readonly StaleTrack[];
  edited: readonly StaleTrack[];
};

export function recordedLanguageName(tracks: readonly StaleTrack[]): string {
  const codes = new Set(tracks.map((t) => t.recorded));
  return codes.size === 1 ? languageName([...codes][0]) : "other languages";
}

type Answer = {
  asked: string | null;
  projectPath: string;
  value: LanguageStatus;
};

export function useLanguageStatus(
  projectPath: string,
  language: string | null,
  refreshKey: string,
): LanguageStatus | null {
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadTranscriptLanguageStatus(projectPath, language, {
      signal: controller.signal,
    })
      .then((status) => {
        if (controller.signal.aborted) return;
        setAnswer({
          asked: language,
          projectPath,
          value: {
            language: status.language,
            stale: status.stale_tracks,
            edited: status.edited_stale_tracks,
          },
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnswer(null);
      });
    return () => controller.abort();
  }, [projectPath, language, refreshKey]);

  return answer &&
    answer.asked === language &&
    answer.projectPath === projectPath
    ? answer.value
    : null;
}
