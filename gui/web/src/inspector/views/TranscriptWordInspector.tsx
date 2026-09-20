import { useEffect, useMemo, useState } from "react";
import {
  correctTranscriptPhrase,
  correctTranscriptWord,
  setTranscriptWordSuppressed,
} from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { ProjectView, TranscriptWordView } from "../../types/project";
import {
  Button,
  DefItem,
  DefinitionList,
  FieldRow,
  InspectorSeekFooter,
} from "../../ui";
import { wordSeekSec } from "../../utils/transcript";
import { ModifierInspector } from "../ModifierInspector";

const LOW_CONFIDENCE = 0.7;

function findWordView(
  project: ProjectView,
  trackId: string,
  wordIndex: number,
): TranscriptWordView | null {
  for (const u of project.transcript?.utterances ?? []) {
    if (u.track_id !== trackId) {
      continue;
    }
    for (const w of u.words ?? []) {
      if (w.word_index === wordIndex) {
        return w;
      }
    }
  }
  return null;
}

export function TranscriptWordInspector({
  trackId,
  wordIndex,
  embedded = false,
}: {
  trackId: string;
  wordIndex: number;
  /** Docked inside TranscriptPanel (text focus) — not the side rail. */
  embedded?: boolean;
}) {
  const { project, projectPath } = useDaw();
  const wordsHydrated = project?.meta.hydration?.transcript_words !== false;
  const word = useMemo(
    () =>
      project && wordsHydrated
        ? findWordView(project, trackId, wordIndex)
        : null,
    [project, trackId, wordIndex, wordsHydrated],
  );
  const { busy, error, setError, run } = useProjectMutation();
  const [text, setText] = useState(word?.text ?? "");
  const [endIndexStr, setEndIndexStr] = useState(String(wordIndex));

  useEffect(() => {
    setText(word?.text ?? "");
    setEndIndexStr(String(wordIndex));
    setError(null);
  }, [word?.text, wordIndex, trackId, setError]);

  const editable = !isShareProjectKey(projectPath);
  const suppressed = Boolean(word?.suppressed);
  const lowConf = word?.confidence != null && word.confidence < LOW_CONFIDENCE;

  const applyText = async () => {
    const endIndex = Number.parseInt(endIndexStr, 10);
    if (!Number.isFinite(endIndex) || endIndex < wordIndex) {
      setError("End index must be an integer ≥ start word index");
      return;
    }
    const next = text.trim();
    if (!next) {
      setError("Text cannot be empty");
      return;
    }
    await run(async () => {
      if (endIndex === wordIndex) {
        await correctTranscriptWord(projectPath, trackId, wordIndex, next);
      } else {
        await correctTranscriptPhrase(
          projectPath,
          trackId,
          wordIndex,
          endIndex,
          next,
        );
      }
    });
  };

  const toggleSuppress = async () => {
    await run(async () => {
      await setTranscriptWordSuppressed(
        projectPath,
        trackId,
        wordIndex,
        !suppressed,
      );
    });
  };

  if (!wordsHydrated) {
    return embedded ? (
      <div className="transcript-docked-editor-missing">
        Loading transcript words…
      </div>
    ) : (
      <aside className="inspector">Loading transcript words…</aside>
    );
  }

  if (!word) {
    return embedded ? (
      <div className="transcript-docked-editor-missing">
        Transcript word not found
      </div>
    ) : (
      <aside className="inspector">Transcript word not found</aside>
    );
  }

  const seekSec = wordSeekSec(word) ?? word.timeline_start ?? word.start;
  const playStart = word.timeline_start ?? word.start;
  const playEnd = word.timeline_end ?? word.end;

  return (
    <ModifierInspector
      badge="Word"
      title={word.text}
      subtitle={`${trackId} · index ${wordIndex}`}
      embedded={embedded}
      primaryActions={
        editable
          ? [
              {
                label: suppressed ? "Unsuppress" : "Suppress",
                variant: "primary",
                disabled: busy,
                onClick: () => void toggleSuppress(),
              },
            ]
          : undefined
      }
      error={error}
      footer={
        <InspectorSeekFooter
          seekSec={seekSec}
          playStart={playStart}
          playEnd={playEnd}
          padSec={0.15}
          playLabel="Play word"
        />
      }
    >
      <DefinitionList>
        <DefItem label="Confidence">
          {word.confidence != null ? word.confidence.toFixed(2) : "—"}
          {lowConf ? " (low)" : ""}
        </DefItem>
        <DefItem label="Suppressed">{suppressed ? "yes" : "no"}</DefItem>
        {editable ? (
          <>
            <DefItem label="Text">
              <FieldRow>
                <input
                  type="text"
                  value={text}
                  disabled={busy}
                  aria-label="Corrected text"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void applyText();
                    }
                  }}
                />
              </FieldRow>
            </DefItem>
            <DefItem label="End index">
              <FieldRow>
                <input
                  type="number"
                  min={wordIndex}
                  value={endIndexStr}
                  disabled={busy}
                  aria-label="End word index"
                  onChange={(e) => setEndIndexStr(e.target.value)}
                  title="Same as start for a single-word correct; higher for phrase"
                />
                <Button disabled={busy} onClick={() => void applyText()}>
                  Apply
                </Button>
              </FieldRow>
            </DefItem>
          </>
        ) : null}
      </DefinitionList>
    </ModifierInspector>
  );
}
